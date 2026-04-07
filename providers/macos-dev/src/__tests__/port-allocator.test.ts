import { describe, it, expect } from "vitest";
import { allocatePort, allocatePorts } from "../port-allocator.js";

describe("allocatePort", () => {
	it("returns a port in the expected range", async () => {
		const port = await allocatePort("test-app", new Set());
		expect(port).toBeGreaterThanOrEqual(10_000);
		expect(port).toBeLessThan(20_000);
	});

	it("is deterministic for the same key", async () => {
		const port1 = await allocatePort("my-app", new Set());
		const port2 = await allocatePort("my-app", new Set());
		expect(port1).toBe(port2);
	});

	it("avoids ports already in use", async () => {
		const port1 = await allocatePort("collision-test", new Set());
		const port2 = await allocatePort("collision-test", new Set([port1]));
		expect(port2).not.toBe(port1);
	});

	it("produces different ports for different keys", async () => {
		const port1 = await allocatePort("app-a", new Set());
		const port2 = await allocatePort("app-b", new Set());
		// Not guaranteed but overwhelmingly likely for different inputs
		expect(port1).not.toBe(port2);
	});
});

describe("allocatePorts", () => {
	it("allocates ports for all components", async () => {
		const components = {
			backend: { provides: [{ port: 3000 }] },
			frontend: { provides: [{ port: 3001 }] },
		};
		const ports = await allocatePorts(components, "test-app");
		expect(ports.backend).toBeDefined();
		expect(ports.frontend).toBeDefined();
		expect(ports.backend).not.toBe(ports.frontend);
	});

	it("prefers the declared port if free", async () => {
		const components = {
			api: { provides: [{ port: 4567 }] },
		};
		const ports = await allocatePorts(components, "test-app");
		expect(ports.api).toBe(4567);
	});

	it("reuses saved ports when available", async () => {
		const components = {
			api: { provides: [{ port: 3000 }] },
		};
		const saved = { api: 9876 };
		const ports = await allocatePorts(components, "test-app", saved);
		expect(ports.api).toBe(9876);
	});
});
