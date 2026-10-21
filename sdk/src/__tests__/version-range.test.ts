import { describe, expect, it } from "vitest";
import { checkVersionRange } from "../version-range.js";

describe("checkVersionRange", () => {
	it("is satisfied when every provided version is inside the range", () => {
		expect(checkVersionRange(">=15", "16.x")).toBe("satisfied");
		expect(checkVersionRange(">=9.6", "16.4.0")).toBe("satisfied");
		expect(checkVersionRange("^7.0", "7.2.4")).toBe("satisfied");
	});

	it("is unsatisfied when no provided version is inside the range", () => {
		expect(checkVersionRange(">=17", "16.x")).toBe("unsatisfied");
		expect(checkVersionRange("^7.0", "8.0.0")).toBe("unsatisfied");
	});

	it("is undecidable when a family straddles the range", () => {
		expect(checkVersionRange("^16.2", "16.x")).toBe("undecidable");
	});

	it("is unknown when the provider does not know its version", () => {
		expect(checkVersionRange(">=15", undefined)).toBe("unknown");
		expect(checkVersionRange(">=15", "latest")).toBe("unknown");
	});

	it("is invalid when the declared string is not a semver range", () => {
		expect(checkVersionRange("seven-ish", "7.x")).toBe("invalid");
		expect(checkVersionRange("seven-ish", undefined)).toBe("invalid");
	});
});
