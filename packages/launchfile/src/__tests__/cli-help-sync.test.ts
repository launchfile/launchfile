/**
 * `--help` names every long flag the CLI accepts (#597). The two declared-flag
 * tables are the allowlist (D-67), so a flag added to either one and left out
 * of the help text fails here. This reads the existing tables; it adds no
 * per-verb table of its own.
 */

import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BOOLEAN_FLAGS, VALUE_FLAGS } from "../cli-args.js";

const CLI = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");

/**
 * The flags the help text does not name. `--detach` must not count as named
 * just because `--detached` is, so a match ends at anything that cannot
 * continue a flag name.
 */
function missingFromHelp(help: string, flags: Iterable<string>): string[] {
	return [...flags].filter(
		(flag) => !new RegExp(`--${flag}(?![\\w-])`).test(help),
	);
}

describe("launchfile --help (built CLI, #597)", () => {
	const help = execFileSync("node", [CLI, "--help"], { encoding: "utf8" });

	it("names every flag in VALUE_FLAGS and BOOLEAN_FLAGS", () => {
		expect(missingFromHelp(help, [...VALUE_FLAGS, ...BOOLEAN_FLAGS])).toEqual(
			[],
		);
	});

	it("describes --detach for both providers", () => {
		expect(help).toContain("--detach         Return after launch.");
		expect(help).toContain("Docker always detaches");
	});

	it("gives --detach no short alias (#529 owns single-dash flags)", () => {
		expect(help).not.toMatch(/--detach, -/);
		expect(help).not.toMatch(/-d,\s+--detach/);
	});
});

describe("missingFromHelp", () => {
	it("reports a flag the help text leaves out", () => {
		expect(
			missingFromHelp("  --json   Machine-readable output", ["json", "quiet"]),
		).toEqual(["quiet"]);
	});

	it("does not count a longer flag as naming its prefix", () => {
		expect(
			missingFromHelp("  --detached  (validate) ...", ["detach", "detached"]),
		).toEqual(["detach"]);
		expect(missingFromHelp("  --components <a,b>", ["component"])).toEqual([
			"component",
		]);
	});

	it("counts a flag followed by a value placeholder or a comma", () => {
		expect(
			missingFromHelp("  --name <label>\n  --follow, -f", ["name", "follow"]),
		).toEqual([]);
	});
});
