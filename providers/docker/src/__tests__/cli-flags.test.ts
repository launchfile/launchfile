import { describe, expect, it } from "vitest";
import { hasFlag } from "../cli-flags.js";

describe("hasFlag", () => {
	it("matches the long form", () => {
		expect(hasFlag(["up", "ghost", "--yes"], "yes")).toBe(true);
		expect(hasFlag(["logs", "--follow"], "follow")).toBe(true);
	});

	it("returns false when the flag is absent", () => {
		expect(hasFlag(["up", "ghost"], "yes")).toBe(false);
	});

	it("does not treat -y or --y as --yes", () => {
		expect(hasFlag(["up", "ghost", "-y"], "yes")).toBe(false);
		expect(hasFlag(["up", "ghost", "--y"], "yes")).toBe(false);
	});

	it("does not treat -f or --f as --follow", () => {
		expect(hasFlag(["logs", "-f"], "follow")).toBe(false);
		expect(hasFlag(["logs", "--f"], "follow")).toBe(false);
	});
});
