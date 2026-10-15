import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { launchToCompose } from "../compose-generator.js";
import {
	applyHostCapabilityGrants,
	type HostCapabilityPolicy,
	type HostCapabilityRequest,
} from "../host-capabilities.js";

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
	return (parse(yaml) as { services: Record<string, Record<string, unknown>> })
		.services;
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
					tmpfs: [
						"/tmp:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=10001,gid=10001",
					],
					pids_limit: 128,
					mem_limit: "512m",
					summary: "caddy-edge-v1 posture",
				},
			};
		};
		const result = launchToCompose(readLaunch(EDGE), {
			hostPorts,
			hostCapabilities: policy,
		});

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
			"granted: edge: host capability privileged=true; network_egress=public-web-only; runtime_hardening=caddy-edge-v1 (caddy-edge-v1 posture)",
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
		const policy: HostCapabilityPolicy = () => ({
			refused: "the operator has not consented",
		});
		const result = launchToCompose(readLaunch(EDGE), {
			hostPorts,
			hostCapabilities: policy,
		});
		expect(result.warnings).toContain(
			"refused: edge requires host capabilities this provider cannot grant " +
				"(privileged=true; network_egress=public-web-only; runtime_hardening=caddy-edge-v1: the operator has not consented) — component skipped",
		);
	});

	it("puts each key of the legacy host block to the policy as its own request, in the entry spelling", () => {
		const seen: HostCapabilityRequest[] = [];
		const policy: HostCapabilityPolicy = (request) => {
			seen.push(request);
			return {
				granted: {
					privileged: true,
					volumes: ["/var/run/docker.sock:/var/run/docker.sock"],
				},
			};
		};
		const result = launchToCompose(readLaunch(LEGACY), {
			hostPorts,
			hostCapabilities: policy,
		});
		expect(seen).toEqual([
			{
				component: "default",
				mode: "requires",
				capabilities: { container_runtime: "docker" },
			},
			{
				component: "default",
				mode: "requires",
				capabilities: { privileged: true },
			},
		]);
		const svc = services(result.yaml).legacyapp;
		expect(svc?.privileged).toBe(true);
		expect(svc?.volumes).toContain("/var/run/docker.sock:/var/run/docker.sock");
	});

	it("leaves an optional capability ungranted with a note when the policy refuses it, and deploys anyway", () => {
		const policy: HostCapabilityPolicy = () => ({
			refused: "no runtime socket here",
		});
		const result = launchToCompose(readLaunch(OPTIONAL), {
			hostPorts,
			hostCapabilities: policy,
		});
		expect(services(result.yaml).optapp).toBeDefined();
		expect(result.warnings).toContain(
			"default: optional host capability container_runtime=any not granted (no runtime socket here) — its set_env vars are omitted and the app runs degraded",
		);
		expect(result.warnings.some((w) => w.startsWith("refused:"))).toBe(false);
	});
});

/** Whether `docker compose` is on this machine, to run the real validator. */
function composeAvailable(): boolean {
	try {
		execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
const withCompose = composeAvailable() ? it : it.skip;

/** `docker compose config -q` on the generated file: exit 0 or the validator's error. */
function composeConfig(yaml: string): { ok: boolean; error: string } {
	const dir = mkdtempSync(join(tmpdir(), "lf-host-grants-"));
	const file = join(dir, "docker-compose.yml");
	writeFileSync(file, yaml);
	try {
		execFileSync("docker", ["compose", "-f", file, "config", "-q"], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		return { ok: true, error: "" };
	} catch (err) {
		return {
			ok: false,
			error: String((err as { stderr?: Buffer }).stderr ?? err),
		};
	}
}

const NETAPP = `
version: launch/v1
name: netapp
components:
  default:
    image: nginx:1
    requires:
      - host: { network: host }
    provides:
      - protocol: http
        port: 80
        exposed: true
  db:
    image: redis:7
`;

const MOUNTS = `
version: launch/v1
name: mountapp
components:
  default:
    image: nginx:1
    requires:
      - host: { filesystem: read-write }
    storage:
      data:
        path: /data
    provides:
      - protocol: http
        port: 80
        exposed: true
`;

const RUNTIME = `
version: launch/v1
name: rtapp
components:
  default:
    image: dockge:1
    requires:
      - host: { container_runtime: docker }
        set_env:
          DOCKER_HOST: $url
          DOCKER_SOCK: \${socket}
    provides:
      - protocol: http
        port: 5001
        exposed: true
`;

const RUNTIME_OPTIONAL = `
version: launch/v1
name: rtopt
components:
  default:
    image: beszel:1
    supports:
      - host: { container_runtime: docker }
        set_env:
          DOCKER_HOST: $url
    provides:
      - protocol: http
        port: 8090
        exposed: true
`;

const SOCKET = "/var/run/docker.sock";

describe("a grant never produces a compose file Docker rejects (PR #774 B1)", () => {
	const hostNetwork: HostCapabilityPolicy = () => ({
		granted: { network_mode: "host" },
	});

	it("drops the project network from a service granted network_mode, and keeps it on the others", () => {
		const result = launchToCompose(readLaunch(NETAPP), {
			hostPorts,
			hostCapabilities: hostNetwork,
		});
		const svc = services(result.yaml);
		expect(svc.netapp?.network_mode).toBe("host");
		expect(svc.netapp?.networks).toBeUndefined();
		expect(svc["netapp-db"]?.networks).toEqual(["launchfile-netapp-net"]);
	});

	withCompose("passes docker compose config with a network_mode grant", () => {
		const result = launchToCompose(readLaunch(NETAPP), {
			hostPorts,
			hostCapabilities: hostNetwork,
		});
		expect(composeConfig(result.yaml)).toEqual({ ok: true, error: "" });
	});

	it("refuses a grant that mounts a named volume, naming why", () => {
		const policy: HostCapabilityPolicy = () => ({
			granted: { volumes: ["hostdata:/srv"] },
		});
		const result = launchToCompose(readLaunch(MOUNTS), {
			hostPorts,
			hostCapabilities: policy,
		});
		expect(result.warnings).toContain(
			"refused: default requires host capabilities this provider cannot grant " +
				"(filesystem=read-write: the grant mounts named volume `hostdata`, which the generated project " +
				"does not declare — grant a host path) — component skipped",
		);
		expect(services(result.yaml).mountapp).toBeUndefined();
	});

	it("refuses a grant that mounts a second volume on a path the service already mounts", () => {
		const policy: HostCapabilityPolicy = () => ({
			granted: { volumes: ["/srv/mountapp:/data/"] },
		});
		const result = launchToCompose(readLaunch(MOUNTS), {
			hostPorts,
			hostCapabilities: policy,
		});
		expect(result.warnings).toContain(
			"refused: default requires host capabilities this provider cannot grant " +
				"(filesystem=read-write: the grant mounts a second volume on `/data`, which the service " +
				"already mounts) — component skipped",
		);
		expect(services(result.yaml).mountapp).toBeUndefined();
	});

	it("refuses the second of two grants that mount the same container path", () => {
		const policy: HostCapabilityPolicy = (request) => ({
			granted: {
				volumes: [
					request.capabilities.container_runtime
						? `${SOCKET}:/run/sock`
						: "/srv/other:/run/sock",
				],
			},
		});
		const launch = readLaunch(`
version: launch/v1
name: twoapp
image: nginx:1
requires:
  - host: { container_runtime: docker }
  - host: { filesystem: read-only }
`);
		const result = launchToCompose(launch, {
			hostPorts,
			hostCapabilities: policy,
		});
		expect(result.warnings).toContain(
			"refused: default requires host capabilities this provider cannot grant " +
				"(filesystem=read-only: the grant mounts a second volume on `/run/sock`, which the service " +
				"already mounts) — component skipped",
		);
	});

	withCompose(
		"passes docker compose config with a host-path grant beside generator storage",
		() => {
			const policy: HostCapabilityPolicy = () => ({
				granted: { volumes: ["/srv/mountapp:/host:ro"] },
			});
			const result = launchToCompose(readLaunch(MOUNTS), {
				hostPorts,
				hostCapabilities: policy,
			});
			const svc = services(result.yaml).mountapp;
			expect(svc?.volumes).toEqual([
				"mountapp-data:/data",
				"/srv/mountapp:/host:ro",
			]);
			expect(composeConfig(result.yaml)).toEqual({ ok: true, error: "" });
		},
	);

	it("applyHostCapabilityGrants: re-applying a grant is a no-op, a conflict is returned, network_mode drops networks", () => {
		const service: Record<string, unknown> = {
			volumes: ["app-data:/data"],
			networks: ["launchfile-app-net"],
		};
		const grant = { volumes: [`${SOCKET}:${SOCKET}`], network_mode: "host" };
		expect(applyHostCapabilityGrants(service, [grant])).toEqual([]);
		expect(applyHostCapabilityGrants(service, [grant])).toEqual([]);
		expect(service.volumes).toEqual(["app-data:/data", `${SOCKET}:${SOCKET}`]);
		expect(service.networks).toBeUndefined();
		expect(
			applyHostCapabilityGrants(service, [
				{ volumes: ["/elsewhere:/data"], cap_add: ["SYS_ADMIN"] },
			]),
		).toEqual([
			"the grant mounts a second volume on `/data`, which the service already mounts",
		]);
		// A rejected grant applies nothing at all.
		expect(service.cap_add).toBeUndefined();
	});
});

describe("a granted entry's set_env resolves against the grant's properties (PR #774 B2)", () => {
	it("wires set_env from the properties the grant supplies", () => {
		const policy: HostCapabilityPolicy = () => ({
			granted: {
				volumes: [`${SOCKET}:${SOCKET}`],
				properties: { socket: SOCKET, url: `unix://${SOCKET}` },
			},
		});
		const result = launchToCompose(readLaunch(RUNTIME), {
			hostPorts,
			hostCapabilities: policy,
		});
		const svc = services(result.yaml).rtapp;
		expect(svc?.environment).toEqual({
			DOCKER_HOST: `unix://${SOCKET}`,
			DOCKER_SOCK: SOCKET,
		});
		expect(svc?.volumes).toEqual([`${SOCKET}:${SOCKET}`]);
	});

	it("refuses a required entry whose grant omits a property its set_env reads, never wiring an empty value (D-52)", () => {
		const policy: HostCapabilityPolicy = () => ({
			granted: {
				volumes: [`${SOCKET}:${SOCKET}`],
				properties: { socket: SOCKET },
			},
		});
		const result = launchToCompose(readLaunch(RUNTIME), {
			hostPorts,
			hostCapabilities: policy,
		});
		expect(result.warnings).toContain(
			"refused: default requires host capabilities this provider cannot grant " +
				"(container_runtime=docker: granted without `url`, which the entry's set_env reads) — component skipped",
		);
		expect(services(result.yaml).rtapp).toBeUndefined();
	});

	it("leaves an optional entry ungranted, with a note, when its grant omits a property", () => {
		const policy: HostCapabilityPolicy = () => ({
			granted: { volumes: [`${SOCKET}:${SOCKET}`] },
		});
		const result = launchToCompose(readLaunch(RUNTIME_OPTIONAL), {
			hostPorts,
			hostCapabilities: policy,
		});
		const svc = services(result.yaml).rtopt;
		expect(svc).toBeDefined();
		expect(svc?.environment).toBeUndefined();
		expect(svc?.volumes).toBeUndefined();
		expect(result.warnings).toContain(
			"default: optional host capability container_runtime=docker not granted " +
				"(granted without `url`, which the entry's set_env reads) — its set_env vars are omitted and the app runs degraded",
		);
	});

	it("wires a granted optional entry's set_env", () => {
		const policy: HostCapabilityPolicy = () => ({
			granted: { properties: { url: "tcp://10.0.0.5:2375" } },
		});
		const result = launchToCompose(readLaunch(RUNTIME_OPTIONAL), {
			hostPorts,
			hostCapabilities: policy,
		});
		expect(services(result.yaml).rtopt?.environment).toEqual({
			DOCKER_HOST: "tcp://10.0.0.5:2375",
		});
	});
});

describe("the legacy host block and its migration get the same decisions (PR #774 B3)", () => {
	const of = (decl: string, policy?: HostCapabilityPolicy) =>
		launchToCompose(
			readLaunch(
				`version: launch/v1\nname: orchestrator\nimage: app:1\n${decl}`,
			),
			{
				hostCapabilities: policy,
			},
		);
	const grantsPrivilegedOnly: HostCapabilityPolicy = (request) =>
		request.capabilities.privileged === true
			? { granted: { privileged: true } }
			: { refused: "not on this host" };

	it("asks once per key and refuses only the key the policy refuses, in both spellings", () => {
		const legacy = of(
			"host:\n  network: host\n  privileged: true\n",
			grantsPrivilegedOnly,
		);
		const entries = of(
			"requires:\n  - host: { network: host }\n  - host: { privileged: true }\n",
			grantsPrivilegedOnly,
		);
		expect(legacy.warnings).toEqual([
			"refused: default requires host capabilities this provider cannot grant " +
				"(network=host (host.network: host): not on this host) — component skipped",
		]);
		expect(entries.warnings).toEqual([
			"refused: default requires host capabilities this provider cannot grant " +
				"(network=host: not on this host) — component skipped",
		]);
		expect(legacy.yaml).toBe(entries.yaml);
	});

	it("puts legacy docker: optional to the policy as a supports request", () => {
		const seen: HostCapabilityRequest[] = [];
		of("host:\n  docker: optional\n", (request) => {
			seen.push(request);
			return { refused: "no" };
		});
		expect(seen).toEqual([
			{
				component: "default",
				mode: "supports",
				capabilities: { container_runtime: "docker" },
			},
		]);
	});
});

describe("behaviour without a policy (PR #774 B4)", () => {
	const of = (decl: string) =>
		launchToCompose(
			readLaunch(`version: launch/v1\nname: plain\nimage: app:1\n${decl}`),
		);

	it("refuses legacy keys with the block spelling suffix, as before", () => {
		expect(
			of("host:\n  docker: required\n  network: host\n  privileged: true\n")
				.warnings,
		).toEqual([
			"refused: default requires host capabilities this provider cannot grant " +
				"(container_runtime=docker (host.docker: required); network=host (host.network: host); " +
				"privileged=true (host.privileged)) — component skipped",
		]);
	});

	it("refuses legacy filesystem: read-write and read-only, as PROVIDERS.md §11 requires", () => {
		for (const value of ["read-write", "read-only"]) {
			const result = of(`host:\n  filesystem: ${value}\n`);
			expect(result.warnings).toEqual([
				"refused: default requires host capabilities this provider cannot grant " +
					`(filesystem=${value} (host.filesystem: ${value})) — component skipped`,
			]);
			expect(result.yaml).not.toContain("app:1");
		}
	});

	it("notes each key of an optional multi-key entry, one line per key", () => {
		const result = of(
			"supports:\n  - host: { container_runtime: any, network: host }\n",
		);
		expect(result.warnings).toEqual([
			"default: optional host capability container_runtime=any not granted — its set_env vars are omitted and the app runs degraded",
			"default: optional host capability network=host not granted — its set_env vars are omitted and the app runs degraded",
		]);
	});

	it("notes legacy docker: optional as an ungranted optional capability", () => {
		const result = of("host:\n  docker: optional\n");
		expect(result.yaml).toContain("app:1");
		expect(result.warnings).toEqual([
			"default: optional host capability container_runtime=docker (host.docker: optional) not granted — its set_env vars are omitted and the app runs degraded",
		]);
	});
});

describe("grant lines are prefixed and policy text is made safe (PR #774 B5)", () => {
	it("strips control characters from a grant summary and a refusal reason", () => {
		const granted = launchToCompose(readLaunch(OPTIONAL), {
			hostPorts,
			hostCapabilities: () => ({
				granted: { summary: "socket\u001b[2Jmounted\nok" },
			}),
		});
		expect(granted.warnings).toContain(
			"granted: default: host capability container_runtime=any (socketmounted\\nok)",
		);
		const refused = launchToCompose(readLaunch(EDGE), {
			hostPorts,
			hostCapabilities: () => ({ refused: "no\u0007\nconsent" }),
		});
		expect(refused.warnings.find((w) => w.startsWith("refused:"))).toContain(
			"runtime_hardening=caddy-edge-v1: no\\nconsent) — component skipped",
		);
		for (const w of [...granted.warnings, ...refused.warnings]) {
			const controls = [...w].filter((ch) => {
				const code = ch.charCodeAt(0);
				return code < 0x20 || code === 0x7f;
			});
			expect(controls).toEqual([]);
		}
	});
});
