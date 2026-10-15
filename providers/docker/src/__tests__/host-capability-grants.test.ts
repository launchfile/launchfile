import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readLaunch } from "@launchfile/sdk";
import { launchToCompose } from "../compose-generator.js";
import type { HostCapabilityPolicy, HostCapabilityRequest } from "../host-capabilities.js";

/** An edge proxy that declares the posture its image's bootstrap needs. */
const EDGE = `
version: launch/v1
name: edgeapp
components:
  web:
    image: nginx:1
    provides:
      - protocol: http
        port: 80
        exposed: true
  edge:
    image: caddy:2
    requires:
      - host:
          privileged: true
          network_egress: public-web-only
          runtime_hardening: caddy-edge-v1
    provides:
      - protocol: https
        port: 443
        exposed: true
`;

const LEGACY = `
version: launch/v1
name: legacyapp
components:
  default:
    image: nginx:1
    host:
      docker: required
      privileged: true
    provides:
      - protocol: http
        port: 80
        exposed: true
`;

const OPTIONAL = `
version: launch/v1
name: optapp
components:
  default:
    image: nginx:1
    supports:
      - host: { container_runtime: any }
    provides:
      - protocol: http
        port: 80
        exposed: true
`;

const hostPorts = { web: 18080, edge: 18443, default: 18080 };

function services(yaml: string): Record<string, Record<string, unknown>> {
	return (parse(yaml) as { services: Record<string, Record<string, unknown>> }).services;
}

describe("host capabilities — the grant/refuse fulfillment mode (D-44, PROVIDERS.md §11)", () => {
	it("refuses a required capability when no policy is supplied, exactly as before", () => {
		const result = launchToCompose(readLaunch(EDGE), { hostPorts });
		expect(result.warnings).toContain(
			"refused: edge requires host capabilities this provider cannot grant " +
				"(privileged=true; network_egress=public-web-only; runtime_hardening=caddy-edge-v1) — component skipped",
		);
		expect(services(result.yaml)["edgeapp-edge"]).toBeUndefined();
	});

	it("grants a required capability through the policy and lands the overlay on that service only", () => {
		const seen: HostCapabilityRequest[] = [];
		const policy: HostCapabilityPolicy = (request) => {
			seen.push(request);
			if (request.capabilities.runtime_hardening !== "caddy-edge-v1") {
				return { refused: "unknown hardening profile" };
			}
			return {
				granted: {
					user: "0:0",
					cap_drop: ["ALL"],
					cap_add: ["NET_ADMIN", "SETGID", "SETPCAP", "SETUID"],
					security_opt: ["no-new-privileges:true"],
					sysctls: { "net.ipv4.ip_unprivileged_port_start": "0" },
					read_only: true,
					tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=10001,gid=10001"],
					pids_limit: 128,
					mem_limit: "512m",
					summary: "caddy-edge-v1 posture",
				},
			};
		};
		const result = launchToCompose(readLaunch(EDGE), { hostPorts, hostCapabilities: policy });

		expect(seen).toEqual([
			{
				component: "edge",
				mode: "requires",
				capabilities: {
					privileged: true,
					network_egress: "public-web-only",
					runtime_hardening: "caddy-edge-v1",
				},
			},
		]);
		expect(result.warnings.some((w) => w.startsWith("refused:"))).toBe(false);
		expect(result.warnings).toContain(
			"edge: host capability privileged=true; network_egress=public-web-only; runtime_hardening=caddy-edge-v1 granted — caddy-edge-v1 posture",
		);
		const edge = services(result.yaml)["edgeapp-edge"];
		expect(edge).toMatchObject({
			user: "0:0",
			cap_drop: ["ALL"],
			cap_add: ["NET_ADMIN", "SETGID", "SETPCAP", "SETUID"],
			security_opt: ["no-new-privileges:true"],
			sysctls: { "net.ipv4.ip_unprivileged_port_start": "0" },
			read_only: true,
			pids_limit: 128,
			mem_limit: "512m",
		});
		// A grant never implies --privileged: the policy said what to set, nothing more.
		expect(edge?.privileged).toBeUndefined();
		const web = services(result.yaml)["edgeapp-web"];
		expect(web?.cap_add).toBeUndefined();
		expect(web?.user).toBeUndefined();
	});

	it("surfaces the policy's reason when it refuses", () => {
		const policy: HostCapabilityPolicy = () => ({ refused: "the operator has not consented" });
		const result = launchToCompose(readLaunch(EDGE), { hostPorts, hostCapabilities: policy });
		expect(result.warnings).toContain(
			"refused: edge requires host capabilities this provider cannot grant " +
				"(privileged=true; network_egress=public-web-only; runtime_hardening=caddy-edge-v1: the operator has not consented) — component skipped",
		);
	});

	it("puts the legacy host block to the policy in the entry spelling", () => {
		const seen: HostCapabilityRequest[] = [];
		const policy: HostCapabilityPolicy = (request) => {
			seen.push(request);
			return { granted: { privileged: true, volumes: ["/var/run/docker.sock:/var/run/docker.sock"] } };
		};
		const result = launchToCompose(readLaunch(LEGACY), { hostPorts, hostCapabilities: policy });
		expect(seen).toEqual([
			{
				component: "default",
				mode: "requires",
				capabilities: { container_runtime: "docker", privileged: true },
			},
		]);
		const svc = services(result.yaml).legacyapp;
		expect(svc?.privileged).toBe(true);
		expect(svc?.volumes).toContain("/var/run/docker.sock:/var/run/docker.sock");
	});

	it("leaves an optional capability ungranted with a note when the policy refuses it, and deploys anyway", () => {
		const policy: HostCapabilityPolicy = () => ({ refused: "no runtime socket here" });
		const result = launchToCompose(readLaunch(OPTIONAL), { hostPorts, hostCapabilities: policy });
		expect(services(result.yaml).optapp).toBeDefined();
		expect(result.warnings).toContain(
			"default: optional host capability container_runtime=any not granted — its set_env vars are omitted and the app runs degraded",
		);
		expect(result.warnings.some((w) => w.startsWith("refused:"))).toBe(false);
	});
});
