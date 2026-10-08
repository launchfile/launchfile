/**
 * This provider's CLI parses `--components` with its own code: the package has
 * no dependency edge to `packages/launchfile`, so the unified CLI's parser
 * cannot be imported. Both entry points must reach `selectionClosure` with the
 * same names or one Launchfile yields two running topologies (P-5, D-41), so
 * this table mirrors `packages/launchfile/src/__tests__/cli-args.test.ts`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import {
	parseComponentsFlag,
	selectorRefusal,
	upComponentRefusal,
} from "../cli-args.js";

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
	it("refuses both spellings on a verb that acts on the whole deployment", () => {
		for (const argv of [
			["down", "--components", "web"],
			["down", "--components=web"],
			["down", "--component", "web"],
			["down", "--component=web"],
		]) {
			const lines = selectorRefusal(argv, "down", "stops the whole deployment");
			expect(lines).toBeDefined();
			expect(lines?.[0]).toContain("`down` stops the whole deployment");
		}
	});

	it("names the spelling typed", () => {
		const plural = selectorRefusal(
			["down", "--components", "web"],
			"down",
			"x",
		);
		const singular = selectorRefusal(
			["down", "--component", "web"],
			"down",
			"x",
		);
		expect(plural?.[0]).toMatch(/^--components selects/);
		expect(singular?.[0]).toMatch(/^--component is not a `launch` flag/);
	});

	it("names --components when both spellings appear, whatever the argv order", () => {
		for (const argv of [
			["down", "--components", "web", "--component", "api"],
			["down", "--component", "api", "--components", "web"],
		]) {
			const lines = selectorRefusal(argv, "down", "x");
			expect(lines?.[0]).toMatch(/^--components selects/);
		}
	});

	it("stays out of the way when no selector is given", () => {
		expect(selectorRefusal(["down", "--destroy"], "down", "x")).toBeUndefined();
		expect(selectorRefusal(["status"], "status", "x")).toBeUndefined();
	});
});

const UP_REFUSAL = [
	"--component is not a `launch` flag; `up` selects components with `--components <name>[,<name>…]`.",
	"Run `launch up --components <name>` instead.",
] as const;

describe("upComponentRefusal", () => {
	it("refuses the singular in its bare and inline forms", () => {
		expect(upComponentRefusal(["up", "--component", "web"])).toEqual(
			UP_REFUSAL,
		);
		expect(upComponentRefusal(["up", "--component=web"])).toEqual(UP_REFUSAL);
	});

	it("leaves the plural selector to `up`", () => {
		expect(upComponentRefusal(["up", "--components", "web"])).toBeUndefined();
		expect(upComponentRefusal(["up", "--components=web"])).toBeUndefined();
		expect(upComponentRefusal(["up"])).toBeUndefined();
	});

	it("names no verb `launch` lacks", () => {
		expect(
			upComponentRefusal(["up", "--component", "web"])?.join("\n"),
		).not.toContain("bootstrap");
	});
});

/**
 * The dispatch wiring: `cli.ts` must call the refusal before `launchDown` /
 * `launchStatus`. Only a spawned process proves that — importing `cli.ts` runs
 * `main()` against this process's argv, and a unit test of `selectorRefusal`
 * passes with both call sites deleted (#414).
 */
describe("down/status refuse a selector before reaching the provider (spawned CLI)", () => {
	const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");

	function run(cliArgs: string[]): {
		stdout: string;
		stderr: string;
		exitCode: number | null;
	} {
		const result = spawnSync("bun", ["run", "src/cli.ts", ...cliArgs], {
			cwd: PACKAGE_ROOT,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.status,
		};
	}

	// Both `launchDown` and `launchStatus` write to stdout on every path — with
	// no state file at the package root that is "No active launch state found."
	// — so an empty stdout means neither ran. Exit 1 alone would not prove it: an
	// unrelated crash exits 1 too, so the refusal's own second line is required.
	it("exits 1 with the refusal on stderr and nothing from the provider on stdout", () => {
		for (const [verb, flags] of [
			["down", ["--components", "web"]],
			["down", ["--component", "web"]],
			["status", ["--components", "web"]],
			["status", ["--component", "web"]],
			["status", ["--components=web"]],
			["status", ["--component=web"]],
		] as const) {
			const { stdout, stderr, exitCode } = run([verb, ...flags]);
			expect(exitCode, `${verb} ${flags.join(" ")}`).toBe(1);
			expect(stderr).toContain(`Run \`${verb}\` with no selector.`);
			expect(stdout).toBe("");
		}
	}, 60_000);
});

/**
 * `up` must refuse `--component` before `launchUp` runs. The spawn runs in an
 * empty directory: every `launchUp` path writes to stderr first there (missing
 * prerequisites, or no Launchfile), so stderr holding exactly the two refusal
 * lines (Bun colours stderr, so escapes are stripped), with nothing on stdout and nothing written to the directory, means
 * the provider never started.
 */
describe("up refuses --component before reaching the provider (spawned CLI)", () => {
	const CLI = resolve(import.meta.dirname, "..", "cli.ts");

	it("exits 1 with the refusal and starts nothing", () => {
		for (const flags of [["--component", "web"], ["--component=web"]]) {
			const cwd = mkdtempSync(resolve(tmpdir(), "launch-up-component-"));
			const result = spawnSync("bun", ["run", CLI, "up", ...flags], {
				cwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			expect(result.status, flags.join(" ")).toBe(1);
			expect(stripVTControlCharacters(result.stderr)).toBe(
				`${UP_REFUSAL.join("\n")}\n`,
			);
			expect(result.stdout).toBe("");
			expect(readdirSync(cwd)).toEqual([]);
		}
	}, 60_000);
});
