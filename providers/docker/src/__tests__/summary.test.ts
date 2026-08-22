import { describe, expect, it } from "vitest";
import { endpointAddress, summaryLines } from "../provider.js";
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
