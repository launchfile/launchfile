/**
 * This provider's CLI parses `--components` with its own code: the package has
 * no dependency edge to `packages/launchfile`, so the unified CLI's parser
 * cannot be imported. Both entry points must reach `selectionClosure` with the
 * same names or one Launchfile yields two running topologies (P-5, D-41), so
 * this table mirrors `packages/launchfile/src/__tests__/cli-args.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { parseComponentsFlag, selectorRefusal } from "../cli-args.js";

describe("parseComponentsFlag (D-41)", () => {
	it("splits a comma-separated value", () => {
		expect(parseComponentsFlag(["up", "--components", "web,api"])).toEqual([
			"web",
			"api",
		]);
	});

	it("parses the inline form", () => {
		expect(parseComponentsFlag(["up", "--components=web,api"])).toEqual([
			"web",
			"api",
		]);
	});

	it("composes repeated flags with comma lists, in order", () => {
		expect(
			parseComponentsFlag([
				"up",
				"--components",
				"web,api",
				"--components",
				"worker",
			]),
		).toEqual(["web", "api", "worker"]);
	});

	it("drops blanks and collapses duplicates", () => {
		expect(
			parseComponentsFlag(["up", "--components", " web , , web , api "]),
		).toEqual(["web", "api"]);
	});

	it("treats an absent or empty selector as every component", () => {
		expect(parseComponentsFlag(["up"])).toBeUndefined();
		expect(parseComponentsFlag(["up", "--components", ""])).toBeUndefined();
		expect(parseComponentsFlag(["up", "--components", " , "])).toBeUndefined();
	});
});

describe("selectorRefusal", () => {
	it("refuses the selector on a verb that acts on the whole deployment", () => {
		for (const argv of [
			["down", "--components", "web"],
			["down", "--components=web"],
		]) {
			const lines = selectorRefusal(argv, "down", "stops the whole deployment");
			expect(lines).toBeDefined();
			expect(lines?.[0]).toContain("`down` stops the whole deployment");
		}
	});

	it("stays out of the way when no selector is given", () => {
		expect(selectorRefusal(["down", "--destroy"], "down", "x")).toBeUndefined();
		expect(selectorRefusal(["status"], "status", "x")).toBeUndefined();
	});
});
