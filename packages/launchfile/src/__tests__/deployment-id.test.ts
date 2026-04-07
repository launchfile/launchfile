import { describe, it, expect } from "vitest";
import { generateDeploymentId } from "../state/deployment-id.js";

describe("generateDeploymentId", () => {
	it("generates a 7-character hex string", () => {
		const id = generateDeploymentId();
		expect(id).toMatch(/^[0-9a-f]{7}$/);
	});

	it("generates unique IDs", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			ids.add(generateDeploymentId());
		}
		// With 7 hex chars (~268M possibilities), 1000 should all be unique
		expect(ids.size).toBe(1000);
	});
});
