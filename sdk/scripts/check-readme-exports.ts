#!/usr/bin/env bun
/**
 * check-readme-exports — enforce that every value export of src/index.ts is
 * accounted for: either a row in README.md's API table, or an entry in
 * EXCLUDED_EXPORTS below with a one-line reason.
 *
 * Runs as a `pretest` hook (package.json), so `bun run test` and CI's
 * existing `sdk` job both exercise it with no separate wiring.
 *
 * Catches four real failure modes:
 *   1. A new value export lands with no README row and no exclusion entry
 *      (silent omission — issue #250).
 *   2. A README row or exclusion entry survives after its export is renamed
 *      or removed (stale documentation).
 *   3. The same name is both documented and excluded (contradictory record).
 *   4. A row whose first cell lists parameters — `name(a, b?)` — disagrees
 *      with the `export function` it documents on how many parameters there
 *      are, or which positions are optional (issue #546). A signature the
 *      check cannot map (overloads, rest or `this` parameters, a const or
 *      class, a re-export leaving src/) fails too, naming the export.
 *
 * It does not check the Description column, parameter names, or what a
 * non-function export like CERTIFICATE means.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	compareArity,
	getReadmeApiTableRows,
	getValueExportSources,
	parseDeclarationParams,
	parseReadmeParams,
	sourcePathForSpecifier,
} from "./readme-exports.ts";

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
	stripControlInline:
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

async function main(): Promise<void> {
	const sdkRoot = resolve(import.meta.dirname, "..");
	const indexTsPath = resolve(sdkRoot, "src/index.ts");
	const readmePath = resolve(sdkRoot, "README.md");

	const exportSources = getValueExportSources(
		readFileSync(indexTsPath, "utf-8"),
	);
	const valueExports = new Set(exportSources.keys());
	const rows = getReadmeApiTableRows(readFileSync(readmePath, "utf-8"));
	const documented = new Set(rows.keys());
	const excluded = new Set(Object.keys(EXCLUDED_EXPORTS));

	const errors: string[] = [];
	let arityChecked = 0;

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

	for (const [name, cell] of rows) {
		const exportSource = exportSources.get(name);
		if (!exportSource) continue; // already reported as a stale row
		try {
			const readmeParams = parseReadmeParams(cell);
			if (readmeParams === null) continue;
			const declPath = sourcePathForSpecifier(exportSource.from);
			const absPath = resolve(sdkRoot, declPath);
			if (!existsSync(absPath)) {
				throw new Error(
					`re-exported from "${exportSource.from}", but ${declPath} does not exist`,
				);
			}
			const decl = parseDeclarationParams(
				readFileSync(absPath, "utf-8"),
				exportSource.localName,
			);
			const mismatch = compareArity(name, cell, readmeParams, declPath, decl);
			if (mismatch) errors.push(mismatch);
			arityChecked++;
		} catch (err) {
			errors.push(
				`"${name}": cannot check the README row's parameters against the declaration: ${(err as Error).message}`,
			);
		}
	}

	if (errors.length > 0) {
		console.error("\n✗ README export coverage check failed:\n");
		for (const err of errors) console.error(`  - ${err}`);
		console.error(
			'\nEvery value export of sdk/src/index.ts must be either a row in README.md\'s "## API" table or an entry in EXCLUDED_EXPORTS (sdk/scripts/check-readme-exports.ts) with a one-line reason. A row that lists parameters must match its `export function` declaration in count and in which positions are optional.\n',
		);
		process.exit(1);
	}

	console.log(
		`✓ README export coverage: ${valueExports.size} value exports — ${documented.size} documented, ${excluded.size} excluded, 0 unaccounted for. ${arityChecked} parameter lists match their declarations.`,
	);
}

await main();
