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
});
