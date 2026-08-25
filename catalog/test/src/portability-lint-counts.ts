#!/usr/bin/env bun
/**
 * Count the D-40/D-43 reduced-portability `validate` diagnostics (issue #155)
 * across a corpus of Launchfiles — the catalog and spec/examples before/after
 * table from the governance verdict.
 *
 * Usage: bun run src/portability-lint-counts.ts
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readLaunch } from "../../../sdk/src/reader.ts";
import { lintLaunch } from "../../../sdk/src/lint.ts";

export interface CorpusCounts {
	/** Number of Launchfiles scanned. */
	files: number;
	/** D-40 warnings, counted per firing component (attached or detached — D-40 doesn't vary by attachment). */
	d40Warnings: number;
	/** Distinct files with at least one D-40 warning. */
	d40Files: number;
	/** D-43 warnings when every file is evaluated attached (the default local `validate` read). */
	d43WarningsAttached: number;
	/** Distinct files with at least one D-43 warning, attached. */
	d43FilesAttached: number;
	/** D-43 warnings when every file is evaluated detached (a standalone/catalog-distribution read). */
	d43WarningsDetached: number;
	/** Distinct files with at least one D-43 warning, detached. */
	d43FilesDetached: number;
	/** Any portability warning (D-40 or D-43, detached) with suppression enabled — must always be 0. */
	warningsWithSuppression: number;
}

/** Every `<root>/<dir>/<app>/Launchfile` that exists, sorted. */
function readAppCorpus(root: string, dir: string): string[] {
	const base = resolve(root, dir);
	return readdirSync(base)
		.map((entry) => join(base, entry, "Launchfile"))
		.filter((p) => existsSync(p))
		.sort();
}

/** Every `*.yaml` directly under `root`, sorted. */
function readYamlCorpus(root: string): string[] {
	return readdirSync(root)
		.filter((f) => f.endsWith(".yaml"))
		.map((f) => resolve(root, f))
		.sort();
}

export function countCorpus(paths: string[]): CorpusCounts {
	const counts: CorpusCounts = {
		files: paths.length,
		d40Warnings: 0,
		d40Files: 0,
		d43WarningsAttached: 0,
		d43FilesAttached: 0,
		d43WarningsDetached: 0,
		d43FilesDetached: 0,
		warningsWithSuppression: 0,
	};

	for (const path of paths) {
		const launch = readLaunch(readFileSync(path, "utf-8"));

		const attached = lintLaunch(launch, { detached: false });
		const detached = lintLaunch(launch, { detached: true });
		const suppressed = lintLaunch(launch, {
			detached: true,
			suppressPortabilityWarnings: true,
		});

		const d40 = attached.filter((w) => w.includes("(D-40)"));
		counts.d40Warnings += d40.length;
		if (d40.length > 0) counts.d40Files++;

		const d43Attached = attached.filter((w) => w.includes("(D-43)"));
		counts.d43WarningsAttached += d43Attached.length;
		if (d43Attached.length > 0) counts.d43FilesAttached++;

		const d43Detached = detached.filter((w) => w.includes("(D-43)"));
		counts.d43WarningsDetached += d43Detached.length;
		if (d43Detached.length > 0) counts.d43FilesDetached++;

		counts.warningsWithSuppression += suppressed.filter(
			(w) => w.includes("(D-40)") || w.includes("(D-43)"),
		).length;
	}

	return counts;
}

export function catalogPaths(catalogRoot: string): string[] {
	return [...readAppCorpus(catalogRoot, "apps"), ...readAppCorpus(catalogRoot, "drafts")];
}

export function specExamplesPaths(specExamplesRoot: string): string[] {
	return readYamlCorpus(specExamplesRoot);
}

function formatRow(label: string, counts: CorpusCounts): string {
	return (
		`| ${label} | ${counts.files} | ${counts.d40Warnings} components / ${counts.d40Files} files ` +
		`| ${counts.d43WarningsAttached} components / ${counts.d43FilesAttached} files ` +
		`| ${counts.d43WarningsDetached} components / ${counts.d43FilesDetached} files ` +
		`| ${counts.warningsWithSuppression} |`
	);
}

if (import.meta.main) {
	const testDir = import.meta.dir.replace(/\/src$/, "");
	const catalogRoot = resolve(testDir, "..");
	const specExamplesRoot = resolve(testDir, "..", "..", "spec", "examples");

	const catalog = countCorpus(catalogPaths(catalogRoot));
	const specExamples = countCorpus(specExamplesPaths(specExamplesRoot));

	console.log("| Corpus | Files | D-40 warnings | D-43 attached | D-43 detached | With suppression |");
	console.log("|---|---|---|---|---|---|");
	console.log(formatRow("catalog/", catalog));
	console.log(formatRow("spec/examples/", specExamples));
}
