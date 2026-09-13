#!/usr/bin/env bun
/**
 * check-readme-exports — enforce that every value export of src/index.ts is
 * accounted for: either a row in README.md's API table, or an entry in
 * EXCLUDED_EXPORTS below with a one-line reason.
 *
 * Runs as a `pretest` hook (package.json), so `bun run test` and CI's
 * existing `sdk` job both exercise it with no separate wiring.
 *
 * Catches three real failure modes:
 *   1. A new value export lands with no README row and no exclusion entry
 *      (silent omission — issue #250).
 *   2. A README row or exclusion entry survives after its export is renamed
 *      or removed (stale documentation).
 *   3. The same name is both documented and excluded (contradictory record).
 *
 * Parses index.ts by regex rather than the TypeScript compiler API: sdk
 * pins `typescript@7`, the native ("Corsa") compiler, which does not ship
 * the classic `ts.createProgram`/`SymbolFlags` JS API this would otherwise
 * use. index.ts is barrel-only and biome-formatted, so a small regex over
 * its `export { … } from "…"` / `export type { … } from "…"` statements is
 * enough to classify every entry as value or type-only.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Value exports that are intentionally not part of the README's curated API
 * table. Every one must still name a real value export of index.ts — a
 * stale entry here is as much a drift bug as a missing README row.
 */
const EXCLUDED_EXPORTS: Record<string, string> = {
	// CLI command implementations: they format output, write to
	// console/stdout, and (cmdValidate, cmdInspect, cmdSchema) call
	// process.exit on failure. Built for the `launchfile` CLI, not for
	// import into another program.
	cmdValidate: "CLI command implementation — calls process.exit on failure",
	cmdInspect:
		"CLI command implementation — prints to stdout, calls process.exit on failure",
	cmdSchema:
		"CLI command implementation — prints to stdout, calls process.exit on failure",

	// Provider error-context vocabulary (errors.ts's own docstring: "the
	// shared vocabulary every provider reports through", PROVIDERS.md §8).
	// This is the shape docker/macos-dev use to report launch failures to
	// the orchestrator, not part of the parse/validate/serialize surface
	// sdk/README.md's API table documents.
	LAUNCH_SLOTS:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",
	LAUNCH_PHASES:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",
	isLaunchPhase:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",
	slotForCommand:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",
	commandForSlot:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",
	dispositionForPhase:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",
	envKeysOf:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",
	TAIL_LINES:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",
	MAX_LINE_CHARS:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",
	stripControl:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",
	tailLines:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",
	buildLaunchErrorContext:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",
	parseLaunchErrorContext:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",
	LaunchError:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",
	isLaunchError:
		"provider error-context vocabulary (PROVIDERS.md §8), not the parse/validate/serialize surface",

	// Deprecation-registry data: the version constants and the registry table
	// that `lintDeprecations` reads. Callers use `lintDeprecations`.
	DEPRECATED_IN: "deprecation-registry data, read via lintDeprecations",
	DEPRECATION_REGISTRY: "deprecation-registry data, read via lintDeprecations",
	REMOVED_IN: "deprecation-registry data, read via lintDeprecations",
};

interface ExportStatement {
	/** Raw specifier list, e.g. ["type Deprecation", "lintDeprecations"]. */
	specifiers: string[];
	/** True for `export type { … }` and `export type * from …` statements. */
	typeOnly: boolean;
}

function parseExportStatements(source: string): ExportStatement[] {
	const statements: ExportStatement[] = [];

	// `export type * from "…";` — wildcard type re-export, no named values.
	const wildcardTypeRe = /export\s+type\s*\*\s*from\s*"[^"]+";/g;
	const withoutWildcards = source.replace(wildcardTypeRe, "");

	// `export type { A, B } from "…";` or `export { A, type B } from "…";`
	const namedExportRe = /export\s+(type\s*)?\{([^}]*)\}\s*from\s*"[^"]+";/gs;
	for (const match of withoutWildcards.matchAll(namedExportRe)) {
		const statementIsTypeOnly = match[1] !== undefined;
		const specifiers = match[2]!
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		statements.push({ specifiers, typeOnly: statementIsTypeOnly });
	}

	// Any other export form — `export * from "…"`, `export const`,
	// `export function`, `export default` — names values this parser cannot
	// see, so the coverage check would pass while documenting nothing. The
	// barrel-only shape of index.ts is what makes the two regexes above
	// sufficient, so enforce it here rather than assuming it.
	const leftover = withoutWildcards
		.replace(namedExportRe, "")
		.match(/^[ \t]*export\b.*$/m);
	if (leftover) {
		throw new Error(
			`src/index.ts has an export form this check cannot parse: ${leftover[0].trim()}\n` +
				`index.ts must stay barrel-only ('export { … } from "…";'), or parseExportStatements must learn the new form.`,
		);
	}

	return statements;
}

/** Resolve one specifier (e.g. "type Foo", "Bar", "Baz as Qux") to its exported name + value/type-ness. */
function resolveSpecifier(
	spec: string,
	statementIsTypeOnly: boolean,
): { name: string; isValue: boolean } {
	const isTypeSpecifier = statementIsTypeOnly || /^type\s+/.test(spec);
	const withoutTypeKeyword = spec.replace(/^type\s+/, "");
	// `X as Y` re-exports under the local name Y.
	const asMatch = withoutTypeKeyword.match(/^(.+?)\s+as\s+(.+)$/);
	const name = (asMatch ? asMatch[2] : withoutTypeKeyword)!.trim();
	return { name, isValue: !isTypeSpecifier };
}

function getValueExports(indexTsPath: string): Set<string> {
	const source = readFileSync(indexTsPath, "utf-8");
	const statements = parseExportStatements(source);

	const values = new Set<string>();
	for (const stmt of statements) {
		for (const spec of stmt.specifiers) {
			const { name, isValue } = resolveSpecifier(spec, stmt.typeOnly);
			if (isValue) values.add(name);
		}
	}
	return values;
}

/** Extract the documented function/export names from README.md's "## API" table. */
function getReadmeApiTableNames(readmePath: string): Set<string> {
	const readme = readFileSync(readmePath, "utf-8");
	const lines = readme.split("\n");

	const headingIdx = lines.findIndex((l) => l.trim() === "## API");
	if (headingIdx === -1) {
		throw new Error(`${readmePath} has no "## API" heading.`);
	}
	const nextHeadingIdx = lines.findIndex(
		(l, i) => i > headingIdx && /^##\s/.test(l),
	);
	const sectionEnd = nextHeadingIdx === -1 ? lines.length : nextHeadingIdx;
	const section = lines.slice(headingIdx + 1, sectionEnd);

	const names = new Set<string>();
	for (const line of section) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) continue;
		// Skip the header row and the `|---|---|` separator row.
		if (/^\|\s*-+\s*\|/.test(trimmed)) continue;
		if (/^\|\s*Function\s*\|/i.test(trimmed)) continue;
		const cellMatch = trimmed.match(/^\|\s*`([^`]+)`/);
		if (!cellMatch) continue;
		const cell = cellMatch[1]!;
		const name = cell.split("(")[0]!.trim();
		names.add(name);
	}
	return names;
}

async function main(): Promise<void> {
	const sdkRoot = resolve(import.meta.dirname, "..");
	const indexTsPath = resolve(sdkRoot, "src/index.ts");
	const readmePath = resolve(sdkRoot, "README.md");

	const valueExports = getValueExports(indexTsPath);
	const documented = getReadmeApiTableNames(readmePath);
	const excluded = new Set(Object.keys(EXCLUDED_EXPORTS));

	const errors: string[] = [];

	if (valueExports.size === 0) {
		errors.push(
			`Parsed zero value exports from ${indexTsPath} — the parser likely broke on a format change. Fix the parser before trusting this check.`,
		);
	}

	for (const name of valueExports) {
		const isDocumented = documented.has(name);
		const isExcluded = excluded.has(name);
		if (isDocumented && isExcluded) {
			errors.push(
				`"${name}" is both a README.md API table row and an EXCLUDED_EXPORTS entry — remove it from one.`,
			);
		} else if (!isDocumented && !isExcluded) {
			errors.push(
				`"${name}" is a value export of src/index.ts with no README.md API table row and no EXCLUDED_EXPORTS entry. Add a row to README.md's "## API" table, or add it to EXCLUDED_EXPORTS in this script with a one-line reason.`,
			);
		}
	}

	for (const name of documented) {
		if (!valueExports.has(name)) {
			errors.push(
				`README.md's API table documents "${name}", but it is no longer a value export of src/index.ts. Remove the row (or fix the export).`,
			);
		}
	}

	for (const name of excluded) {
		if (!valueExports.has(name)) {
			errors.push(
				`EXCLUDED_EXPORTS lists "${name}" (${EXCLUDED_EXPORTS[name]}), but it is no longer a value export of src/index.ts. Remove the stale entry.`,
			);
		}
	}

	if (errors.length > 0) {
		console.error("\n✗ README export coverage check failed:\n");
		for (const err of errors) console.error(`  - ${err}`);
		console.error(
			'\nEvery value export of sdk/src/index.ts must be either a row in README.md\'s "## API" table or an entry in EXCLUDED_EXPORTS (sdk/scripts/check-readme-exports.ts) with a one-line reason.\n',
		);
		process.exit(1);
	}

	console.log(
		`✓ README export coverage: ${valueExports.size} value exports — ${documented.size} documented, ${excluded.size} excluded, 0 unaccounted for.`,
	);
}

await main();
