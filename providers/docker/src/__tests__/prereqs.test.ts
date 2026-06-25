import { describe, it, expect } from "vitest";
import { composeVersionAtLeast } from "../prereqs.js";

describe("composeVersionAtLeast", () => {
	it("accepts versions at or above the threshold", () => {
		expect(composeVersionAtLeast("2.18.0", 2, 18)).toBe(true);
		expect(composeVersionAtLeast("v2.18.1", 2, 18)).toBe(true);
		expect(composeVersionAtLeast("2.39.1", 2, 18)).toBe(true);
		expect(composeVersionAtLeast("3.0.0", 2, 18)).toBe(true);
	});

	it("rejects versions below the threshold", () => {
		expect(composeVersionAtLeast("2.17.9", 2, 18)).toBe(false);
		expect(composeVersionAtLeast("v2.2.3", 2, 18)).toBe(false);
		expect(composeVersionAtLeast("1.29.2", 2, 18)).toBe(false);
	});

	it("returns false for unparseable output (conservative fallback)", () => {
		expect(composeVersionAtLeast("", 2, 18)).toBe(false);
		expect(composeVersionAtLeast("dev-build", 2, 18)).toBe(false);
	});
});
