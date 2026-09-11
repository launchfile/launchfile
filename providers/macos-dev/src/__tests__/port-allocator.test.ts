import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { allocatePort, allocatePorts } from "../port-allocator.js";

/** Hold a real listener on `port` for the duration of `fn`. */
async function occupying<T>(port: number, fn: () => Promise<T>): Promise<T> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	try {
		return await fn();
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

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

describe("allocatePorts — the exposed endpoint anchors the port (D-27, P-5)", () => {
	it("allocates the first exposed: true entry, not provides[0]", async () => {
		const components = {
			api: {
				provides: [
					{ port: 9000 },
					{ port: 8080, exposed: true },
				],
			},
		};
		const ports = await allocatePorts(components, "anchor-test");
		expect(ports.api).toBe(8080);
	});

	it("keeps provides[0] when nothing is exposed", async () => {
		const components = {
			worker: { provides: [{ port: 9000 }] },
		};
		const ports = await allocatePorts(components, "anchor-test");
		expect(ports.worker).toBe(9000);
	});

	it("falls through to the deterministic allocator when the anchor port is taken", async () => {
		const components = {
			api: {
				provides: [
					{ port: 9000 },
					{ port: 8080, exposed: true },
				],
			},
		};
		const ports = await occupying(8080, () => allocatePorts(components, "anchor-test"));
		// Not the anchor (taken), and not provides[0] either — the anchor being
		// unavailable does not hand the port back to the internal endpoint.
		expect(ports.api).not.toBe(8080);
		expect(ports.api).not.toBe(9000);
		expect(ports.api).toBeGreaterThanOrEqual(10_000);
		expect(ports.api).toBeLessThan(20_000);
	});
});
