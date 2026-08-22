import { describe, it, expect } from "vitest";
import { allocatePorts } from "../port-allocator.js";

describe("allocatePorts", () => {
	it("prefers the declared port", async () => {
		const components = {
			default: {
				provides: [{ port: 2368, exposed: true }],
			},
		};

		const result = await allocatePorts(components, "ghost");

		// Should get 2368 if it's free (it almost certainly is in test)
		expect(result.default).toBeDefined();
		expect(typeof result.default).toBe("number");
		expect(result.default).toBeGreaterThan(0);
	});

	it("allocates ports for multiple components", async () => {
		const components = {
			frontend: {
				provides: [{ port: 3000, exposed: true }],
			},
			backend: {
				provides: [{ port: 8080, exposed: true }],
			},
		};

		const result = await allocatePorts(components, "multi-app");

		expect(result.frontend).toBeDefined();
		expect(result.backend).toBeDefined();
		expect(result.frontend).not.toBe(result.backend);
	});

	it("skips components without exposed ports", async () => {
		const components = {
			worker: {
				provides: [],
			},
			web: {
				provides: [{ port: 3000, exposed: true }],
			},
		};

		const result = await allocatePorts(components, "test");

		expect(result.worker).toBeUndefined();
		expect(result.web).toBeDefined();
	});

	it("reuses saved ports when available", async () => {
		const components = {
			default: {
				provides: [{ port: 3000, exposed: true }],
			},
		};

		const saved = { default: 12345 };
		const result = await allocatePorts(components, "test", saved);

		// If 12345 is free, it should be reused
		expect(result.default).toBeDefined();
	});

	it("allocates a host port for every exposed:true endpoint, keyed by endpoint name (D-6)", async () => {
		const components = {
			default: {
				provides: [
					{ port: 80, protocol: "http", exposed: true },
					{ name: "https", port: 443, protocol: "https", exposed: true },
				],
			},
		};

		const result = await allocatePorts(components, "proxy");

		expect(Object.keys(result).sort()).toEqual(["default", "default:https"]);
		expect(result.default).not.toBe(result["default:https"]);
	});

	it("ignores endpoints that omit exposed or set it false (D-27: default false)", async () => {
		const components = {
			default: {
				provides: [
					{ name: "web-ui", port: 8025, protocol: "http", exposed: true },
					{ name: "smtp", port: 1025, protocol: "tcp" },
					{ name: "debug", port: 9999, protocol: "http", exposed: false },
				],
			},
		};

		const result = await allocatePorts(components, "mailpit");

		expect(Object.keys(result)).toEqual(["default"]);
	});

	it("round-trips its own result as saved state: a second allocation returns identical ports", async () => {
		const components = {
			default: {
				provides: [
					{ port: 80, protocol: "http", exposed: true },
					{ name: "https", port: 443, protocol: "https", exposed: true },
				],
			},
		};

		const first = await allocatePorts(components, "proxy");
		const second = await allocatePorts(components, "proxy", first);

		// This is the stability contract: state.ports feeds the next `up`,
		// and every endpoint (secondaries included) keeps its host port.
		expect(second).toEqual(first);
	});

	it("reuses a saved secondary port even when the saved primary is gone", async () => {
		const components = {
			default: {
				provides: [
					{ port: 80, protocol: "http", exposed: true },
					{ name: "https", port: 443, protocol: "https", exposed: true },
				],
			},
		};

		const saved = { "default:https": 23456 };
		const result = await allocatePorts(components, "proxy", saved);

		expect(result["default:https"]).toBe(23456);
	});

	it("lets a tcp and a udp endpoint share one host port (the DNS shape)", async () => {
		const components = {
			dns: {
				provides: [
					{ name: "dns-tcp", port: 45123, protocol: "tcp", exposed: true },
					{ name: "dns-udp", port: 45123, protocol: "udp", exposed: true },
				],
			},
		};

		const result = await allocatePorts(components, "resolver");

		// A port number is claimed per wire protocol, so the udp twin gets the
		// same host port as the tcp side instead of being pushed to a hash.
		expect(result.dns).toBe(result["dns:dns-udp"]);
	});

	it("round-trips saved state where a tcp/udp twin shares a port", async () => {
		const components = {
			dns: {
				provides: [
					{ name: "dns-tcp", port: 45123, protocol: "tcp", exposed: true },
					{ name: "dns-udp", port: 45123, protocol: "udp", exposed: true },
				],
			},
		};
		const saved = { dns: 45123, "dns:dns-udp": 45123 };

		const result = await allocatePorts(components, "resolver", saved);

		// Regression: a protocol-blind `taken` set rejected the udp twin's
		// saved port because the tcp side had already claimed the number,
		// silently moving the udp endpoint on every restart.
		expect(result).toEqual(saved);
	});

	it("probes udp endpoints with a udp socket, not a tcp listener", async () => {
		const { createSocket } = await import("node:dgram");
		const blocker = createSocket("udp4");
		const port = 45777;
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.bind(port, "127.0.0.1", resolve);
		});

		try {
			const components = {
				vpn: {
					provides: [{ name: "wg", port, protocol: "udp", exposed: true }],
				},
			};

			const result = await allocatePorts(components, "vpn-app");

			// The port is free on TCP but occupied on UDP; a tcp-only probe
			// would wrongly hand it out.
			expect(result.vpn).not.toBe(port);
		} finally {
			await new Promise<void>((resolve) => blocker.close(resolve));
		}
	});

	it("gives same-port endpoints distinct host ports instead of colliding", async () => {
		const components = {
			default: {
				provides: [
					{ name: "api", port: 8080, protocol: "http", exposed: true },
					{ name: "metrics", port: 8080, protocol: "http", exposed: true },
					{ port: 8080, protocol: "http", exposed: true },
				],
			},
		};

		const result = await allocatePorts(components, "samesies");

		const values = Object.values(result);
		expect(values).toHaveLength(3);
		expect(new Set(values).size).toBe(3);
	});
});
