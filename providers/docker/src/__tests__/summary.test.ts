import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { printedPrimaryEndpoint } from "../app-url.js";
import { launchToCompose } from "../compose-generator.js";
import { endpointAddress, statusLines, summaryLines } from "../provider.js";
import type { StateEndpoint } from "../state.js";

describe("summaryLines", () => {
	const ports = { frontend: 54000, backend: 54001 };

	it("reports every component when no selector is given", () => {
		const lines = summaryLines("acme", ports);
		expect(lines).toHaveLength(2);
		expect(lines).toContain("  frontend is running at http://localhost:54000");
		expect(lines).toContain("  backend is running at http://localhost:54001");
	});

	it("reports only the components actually started under a selector", () => {
		const lines = summaryLines("acme", ports, new Set(["backend"]));
		expect(lines).toEqual(["  backend is running at http://localhost:54001"]);
	});

	it("uses the app name as the label for the default component", () => {
		const lines = summaryLines("acme", { default: 54000 });
		expect(lines).toEqual(["  acme is running at http://localhost:54000"]);
	});

	it("returns no lines when the selected set matches nothing", () => {
		expect(summaryLines("acme", ports, new Set(["nope"]))).toEqual([]);
	});

	it("reports secondary endpoints under their component's selector", () => {
		// A composite key must not vanish when its component is selected —
		// that would reintroduce the silent-endpoint failure this fix removes.
		const multi = { caddy: 54000, "caddy:https": 54001, other: 54002 };
		const lines = summaryLines("acme", multi, new Set(["caddy"]));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("caddy is running at");
		expect(lines[1]).toContain("caddy (https) is running at");
	});

	it("prints protocol-correct addresses from endpoint metadata", () => {
		const ports = { default: 18025, "default:smtp": 18026, "default:wg": 18027 };
		const endpoints: Record<string, StateEndpoint> = {
			default: { component: "default", name: "web-ui", containerPort: 8025, hostPort: 18025, protocol: "http" },
			"default:smtp": { component: "default", name: "smtp", containerPort: 1025, hostPort: 18026, protocol: "tcp" },
			"default:wg": { component: "default", name: "wg", containerPort: 51820, hostPort: 18027, protocol: "udp" },
		};
		const lines = summaryLines("mailpit", ports, undefined, endpoints);
		expect(lines[0]).toBe("  mailpit is running at http://localhost:18025");
		expect(lines[1]).toBe("  mailpit (smtp) is running at localhost:18026 (tcp)");
		expect(lines[2]).toBe("  mailpit (wg) is running at localhost:18027 (udp)");
	});

	it("falls back to legacy http labels for state without endpoint metadata", () => {
		const lines = summaryLines("acme", { "caddy:443": 54001 });
		expect(lines).toEqual(["  caddy (443) is running at http://localhost:54001"]);
	});
});

describe("endpointAddress", () => {
	it("maps protocols to browsable or raw address forms", () => {
		expect(endpointAddress(8080, "http")).toBe("http://localhost:8080");
		expect(endpointAddress(8443, "https")).toBe("https://localhost:8443");
		expect(endpointAddress(4000, "ws")).toBe("ws://localhost:4000");
		expect(endpointAddress(1025, "tcp")).toBe("localhost:1025 (tcp)");
		expect(endpointAddress(53, "udp")).toBe("localhost:53 (udp)");
		expect(endpointAddress(50051, "grpc")).toBe("localhost:50051 (grpc)");
		// Unknown/missing protocol keeps the legacy form (old state files)
		expect(endpointAddress(3000, undefined)).toBe("http://localhost:3000");
	});
});

/**
 * The supplied publication URL on the printout (#386, D-58): the primary
 * endpoint's key shows the URL, every other key and every non-HTTP listener
 * keeps this provider's own address, and no URL means no change at all.
 */
describe("printed addresses under a supplied publication URL (#386)", () => {
	const ports = { default: 18025, "default:smtp": 18026, "default:ws": 18027, other: 18028 };
	const endpoints: Record<string, StateEndpoint> = {
		default: { component: "default", name: "web-ui", containerPort: 8025, hostPort: 18025, protocol: "http" },
		"default:smtp": { component: "default", name: "smtp", containerPort: 1025, hostPort: 18026, protocol: "tcp" },
		"default:ws": { component: "default", name: "ws", containerPort: 8030, hostPort: 18027, protocol: "ws" },
		other: { component: "other", containerPort: 9000, hostPort: 18028, protocol: "https" },
	};
	const publication = { appUrl: "https://mail.example.com", primaryEndpoint: "default" };

	it("endpointAddress prints the supplied URL for an http listener, as stored", () => {
		expect(endpointAddress(18025, "http", "https://mail.example.com")).toBe("https://mail.example.com");
		expect(endpointAddress(18025, "https", "https://mail.example.com")).toBe("https://mail.example.com");
		// A non-root path survives verbatim (D-58 rule 2) — no second normalization.
		expect(endpointAddress(18025, "http", "https://mail.example.com/notes")).toBe(
			"https://mail.example.com/notes",
		);
		// Legacy state without endpoint metadata is an http listener too.
		expect(endpointAddress(18025, undefined, "https://mail.example.com")).toBe("https://mail.example.com");
	});

	it("endpointAddress leaves tcp and udp listeners alone even with a URL — they have no origin", () => {
		expect(endpointAddress(18026, "tcp", "https://mail.example.com")).toBe("localhost:18026 (tcp)");
		expect(endpointAddress(53, "udp", "https://mail.example.com")).toBe("localhost:53 (udp)");
	});

	it("endpointAddress prints a URL passed for a ws or grpc listener, and its own form without one", () => {
		expect(endpointAddress(18027, "ws", "https://mail.example.com")).toBe("https://mail.example.com");
		expect(endpointAddress(50051, "grpc", "https://mail.example.com")).toBe("https://mail.example.com");
		expect(endpointAddress(18027, "ws")).toBe("ws://localhost:18027");
		expect(endpointAddress(50051, "grpc")).toBe("localhost:50051 (grpc)");
	});

	it("summaryLines shows the URL on the primary key and localhost on every other", () => {
		expect(summaryLines("mailpit", ports, undefined, endpoints, publication)).toEqual([
			"  mailpit is running at https://mail.example.com",
			"  mailpit (smtp) is running at localhost:18026 (tcp)",
			"  mailpit (ws) is running at ws://localhost:18027",
			"  other is running at https://localhost:18028",
		]);
	});

	it("statusLines places the URL the same way", () => {
		expect(statusLines(ports, endpoints, publication)).toEqual([
			"  default: https://mail.example.com",
			"  default:smtp: localhost:18026 (tcp)",
			"  default:ws: ws://localhost:18027",
			"  other: https://localhost:18028",
		]);
	});

	it("keeps a non-HTTP primary unchanged — the URL asserts nothing about what it speaks", () => {
		const tcpFirst = { default: 18026, "default:web": 18025 };
		const tcpEndpoints: Record<string, StateEndpoint> = {
			default: { component: "default", name: "smtp", containerPort: 1025, hostPort: 18026, protocol: "tcp" },
			"default:web": { component: "default", name: "web", containerPort: 8025, hostPort: 18025, protocol: "http" },
		};
		const lines = summaryLines("mailpit", tcpFirst, undefined, tcpEndpoints, publication);
		expect(lines).toEqual([
			"  mailpit is running at localhost:18026 (tcp)",
			"  mailpit (web) is running at http://localhost:18025",
		]);
		expect(statusLines(tcpFirst, tcpEndpoints, publication)).toEqual([
			"  default: localhost:18026 (tcp)",
			"  default:web: http://localhost:18025",
		]);
	});

	it("is byte-identical to today without a URL, with a URL but no recorded primary, and with no state", () => {
		const plain = summaryLines("mailpit", ports, undefined, endpoints);
		expect(plain[0]).toBe("  mailpit is running at http://localhost:18025");
		expect(summaryLines("mailpit", ports, undefined, endpoints, {})).toEqual(plain);
		expect(summaryLines("mailpit", ports, undefined, endpoints, { primaryEndpoint: "default" })).toEqual(plain);
		// A state file from before the primary key was recorded: URL set, key unknown.
		expect(
			summaryLines("mailpit", ports, undefined, endpoints, { appUrl: "https://mail.example.com" }),
		).toEqual(plain);
		expect(statusLines(ports, endpoints)).toEqual(statusLines(ports, endpoints, {}));
		expect(statusLines(ports, endpoints)[0]).toBe("  default: http://localhost:18025");
	});

	it("respects the component selector alongside the URL", () => {
		expect(summaryLines("mailpit", ports, new Set(["other"]), endpoints, publication)).toEqual([
			"  other is running at https://localhost:18028",
		]);
	});
});

/**
 * Which primary key `up` records for the printouts (§7): one a declared
 * `https-origin` names, whatever HTTP-family listener it has (D-60 rule 4),
 * else an `http`/`https` primary only.
 */
describe("printedPrimaryEndpoint — the key the printouts place the URL on (#386)", () => {
	const DECLARED_WS = `
name: socket
image: socket-like
provides:
  - name: ui
    protocol: http
    port: 3000
    exposed: true
  - name: live
    protocol: ws
    port: 3001
    exposed: true
supports:
  - type: https-origin
    endpoint: live
env:
  APP_URL:
    default: $app.url
`;
	const hostPorts = { default: 13000, "default:live": 13001 };
	const appUrl = "https://socket.example.com";

	function recorded(yaml: string, ports: Record<string, number> = hostPorts) {
		const launch = readLaunch(yaml);
		const result = launchToCompose(launch, { hostPorts: ports, appUrl });
		const key = result.primaryEndpoint;
		const primaryEndpoint = printedPrimaryEndpoint(
			launch,
			key,
			key === undefined ? undefined : result.endpoints[key]?.protocol,
		);
		return { result, primaryEndpoint };
	}

	it("prints the supplied URL for a ws primary a declared https-origin names (D-60 rule 4)", () => {
		const { result, primaryEndpoint } = recorded(DECLARED_WS);
		expect(primaryEndpoint).toBe("default:live");
		const publication = { appUrl, primaryEndpoint };
		expect(summaryLines("socket", result.ports, undefined, result.endpoints, publication)).toEqual([
			"  socket is running at http://localhost:13000",
			`  socket (live) is running at ${appUrl}`,
		]);
		expect(statusLines(result.ports, result.endpoints, publication)).toEqual([
			"  default: http://localhost:13000",
			`  default:live: ${appUrl}`,
		]);
	});

	it("prints the supplied URL for a grpc primary a declared https-origin names", () => {
		const { result, primaryEndpoint } = recorded(DECLARED_WS.replace("protocol: ws", "protocol: grpc"));
		expect(primaryEndpoint).toBe("default:live");
		expect(statusLines(result.ports, result.endpoints, { appUrl, primaryEndpoint })).toEqual([
			"  default: http://localhost:13000",
			`  default:live: ${appUrl}`,
		]);
	});

	it("records no key for a ws, grpc, tcp or udp primary no https-origin names", () => {
		const positional = (protocol: string) => `
name: socket
image: socket-like
provides:
  - name: live
    protocol: ${protocol}
    port: 3001
    exposed: true
`;
		for (const protocol of ["ws", "grpc", "tcp", "udp"]) {
			const { result, primaryEndpoint } = recorded(positional(protocol), { default: 13001 });
			expect(result.primaryEndpoint).toBe("default");
			expect(primaryEndpoint).toBeUndefined();
			expect(statusLines(result.ports, result.endpoints, { appUrl, primaryEndpoint })).toEqual([
				`  default: ${endpointAddress(13001, protocol)}`,
			]);
		}
	});

	it("records the key for a positional http or https primary", () => {
		const { primaryEndpoint } = recorded(DECLARED_WS.replace(/supports:[\s\S]*?endpoint: live\n/, ""));
		expect(primaryEndpoint).toBe("default");
	});

	it("records nothing when nothing is published", () => {
		expect(printedPrimaryEndpoint(readLaunch("name: bare\nimage: bare\n"), undefined, undefined)).toBeUndefined();
	});
});
