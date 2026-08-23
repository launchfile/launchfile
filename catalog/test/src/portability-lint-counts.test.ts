import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogPaths, countCorpus, specExamplesPaths } from "./portability-lint-counts.ts";

/**
 * Pins the D-40/D-43 reduced-portability catalog counts from issue #155's
 * governance verdict, so a predicate change shows up as a failing assertion
 * here rather than silent drift. See `portability-lint-counts.ts` to
 * reproduce this table on demand (`bun run src/portability-lint-counts.ts`).
 */
describe("D-40/D-43 catalog counts (issue #155 verdict, T6)", () => {
	const testDir = import.meta.dirname;
	const catalogRoot = resolve(testDir, "..", "..");
	const specExamplesRoot = resolve(testDir, "..", "..", "..", "spec", "examples");

	it("catalog/: D-40 fires on 130/132 components, 112/113 files", () => {
		const counts = countCorpus(catalogPaths(catalogRoot));
		expect(counts.files).toBe(113);
		expect(counts.d40Warnings).toBe(130);
		expect(counts.d40Files).toBe(112);
	});

	it("catalog/: D-43 never fires, attached or forced detached", () => {
		const counts = countCorpus(catalogPaths(catalogRoot));
		expect(counts.d43WarningsAttached).toBe(0);
		expect(counts.d43WarningsDetached).toBe(0);
	});

	it("spec/examples/: D-40 fires on 4/12 files (prebuilt-image, storage-paths, host-container-runtime, post-start-capture)", () => {
		const counts = countCorpus(specExamplesPaths(specExamplesRoot));
		expect(counts.files).toBe(12);
		expect(counts.d40Files).toBe(4);
	});

	it("spec/examples/: D-43 stays silent attached (every file is an in-tree read)", () => {
		const counts = countCorpus(specExamplesPaths(specExamplesRoot));
		expect(counts.d43WarningsAttached).toBe(0);
	});

	it("spec/examples/: D-43 forced detached fires on 8/12 files — the false-positive count Boundary 2 keeps out of the default attached read", () => {
		const counts = countCorpus(specExamplesPaths(specExamplesRoot));
		expect(counts.d43FilesDetached).toBe(8);
	});

	it("suppression silences every portability warning in both corpora", () => {
		const catalog = countCorpus(catalogPaths(catalogRoot));
		const specExamples = countCorpus(specExamplesPaths(specExamplesRoot));
		expect(catalog.warningsWithSuppression).toBe(0);
		expect(specExamples.warningsWithSuppression).toBe(0);
	});
});
