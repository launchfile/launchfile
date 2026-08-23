/**
 * Repo-wide regression guard for D-52 / PROVIDERS.md §10 rule 8.
 *
 * The name-guessing heuristic this change removed did not live in one place —
 * it had already been copied from the docker provider into the catalog harness,
 * which is why one bug had to be fixed twice and why `health_check_passed:
 * true` certified apps the provider could not deploy. A unit test on either
 * copy would have passed while the other kept fabricating. This walks the source
 * of both trees instead, so a third copy fails CI on the commit that adds it.
 *
 * There is exactly one copy of this guard, and it lives in the docker suite
 * because CI runs the provider matrix and does not run `catalog/test`. Copying
 * it per-package would be the same mistake it exists to catch — and each copy
 * would flag the others' forbidden-string literals.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const TREES = ["providers", join("catalog", "test")];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".tmp", "coverage"]);

/** This file states the forbidden strings in order to forbid them. */
const SELF = fileURLToPath(import.meta.url);

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...sourceFiles(full));
		} else if (/\.(ts|tsx|js|mjs)$/.test(entry) && full !== SELF) {
			out.push(full);
		}
	}
	return out;
}

const FILES = TREES.flatMap((t) => sourceFiles(join(REPO_ROOT, t)));

/**
 * A fabrication constant is only a violation when it is *produced*. Tests that
 * assert its absence must be free to name it, so a line is exempt when it reads
 * as an assertion (`not.toContain`, `expect(...).not`) rather than a value.
 */
const isAssertion = (line: string): boolean =>
	line.includes("not.toContain") ||
	line.includes("not.toMatch") ||
	line.includes("toBeUndefined") ||
	line.trimStart().startsWith("*") ||
	line.trimStart().startsWith("//");

const offenders = (needle: string): string[] => {
	const hits: string[] = [];
	for (const file of FILES) {
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((line, i) => {
			if (!line.includes(needle)) return;
			if (isAssertion(line)) return;
			hits.push(`${relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`);
		});
	}
	return hits;
};

describe("no fabrication heuristic survives anywhere (D-52, rule 8)", () => {
	it("scans a non-trivial number of source files", () => {
		// A guard that silently walked an empty tree would pass forever.
		expect(FILES.length).toBeGreaterThan(30);
	});

	it("no provider or harness produces a PLACEHOLDER constant", () => {
		expect(offenders("PLACEHOLDER")).toEqual([]);
	});

	it("no provider or harness produces a test@localhost guess", () => {
		expect(offenders("test@localhost")).toEqual([]);
	});

	it("no provider or harness produces a bare http://localhost stand-in", () => {
		// The catalog harness legitimately builds `$app.*` from a localhost URL,
		// which is a computed platform property (D-33), not a name-derived guess.
		// What is forbidden is emitting it as a value FOR a variable.
		const guesses = offenders('return "http://localhost"');
		expect(guesses).toEqual([]);
	});

	it("no name-guessing branch keyed on the variable's own name survives", () => {
		// The exact shape of the deleted heuristic: lower-casing the env key and
		// branching on substrings of it.
		const shapes = [
			offenders('lowerKey.includes("url")'),
			offenders('lowerKey.includes("email")'),
			offenders('key?.toLowerCase()'),
		].flat();
		expect(shapes).toEqual([]);
	});
});
