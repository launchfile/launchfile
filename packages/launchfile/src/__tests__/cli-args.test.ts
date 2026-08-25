/**
 * Argument-parsing rules (#248): a value-taking flag's value must never be
 * read as a positional, and the `--flag=value` spelling must parse — it is
 * the form the CLI roadmap's UC4 itself uses.
 */

import { describe, expect, it } from "vitest";
import { getFlagValue, getPositional, hasFlag } from "../cli-args.js";

describe("getPositional (#248)", () => {
	it("skips the value of a value-taking flag", () => {
		const args = ["up", "--name", "foo"];
		expect(getPositional(args, 0)).toBe("up");
		// `foo` is --name's value, not the up target.
		expect(getPositional(args, 1)).toBeUndefined();
	});

	it("still finds a positional placed after a value-taking flag", () => {
		const args = ["up", "--name", "foo", "./app"];
		expect(getPositional(args, 0)).toBe("up");
		expect(getPositional(args, 1)).toBe("./app");
	});

	it("covers --component the same way", () => {
		const args = ["bootstrap", "--component", "web", "ghost"];
		expect(getPositional(args, 1)).toBe("ghost");
	});

	it("treats --flag=value as a single token needing no skip", () => {
		const args = ["up", "--name=foo", "./app"];
		expect(getPositional(args, 1)).toBe("./app");
		expect(getPositional(["up", "--name=foo"], 1)).toBeUndefined();
	});

	it("does not skip the token after a boolean flag", () => {
		const args = ["up", "--dry-run", "ghost"];
		expect(getPositional(args, 1)).toBe("ghost");
	});
});

describe("getFlagValue", () => {
	it("reads the separate-token form", () => {
		expect(getFlagValue(["up", "--name", "foo"], "name")).toBe("foo");
	});

	it("reads the --flag=value form (UC4's spelling)", () => {
		expect(getFlagValue(["up", "--name=ghost-test"], "name")).toBe("ghost-test");
	});

	it("returns undefined when the flag is absent or has no value", () => {
		expect(getFlagValue(["up"], "name")).toBeUndefined();
		expect(getFlagValue(["up", "--name"], "name")).toBeUndefined();
	});
});

describe("hasFlag", () => {
	it("matches long and short forms", () => {
		expect(hasFlag(["logs", "--follow"], "follow")).toBe(true);
		expect(hasFlag(["logs", "-f"], "follow")).toBe(true);
		expect(hasFlag(["logs"], "follow")).toBe(false);
	});
});
