import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LintError, lintLockfileRanges } from "./lint-lockfile-ranges.mjs";

const fixture = (name) =>
	join(fileURLToPath(new URL("./__fixtures__/lockfile-ranges/", import.meta.url)), name);

describe("lintLockfileRanges", () => {
	it("passes when recorded and declared ranges match (real trailing-comma layout)", () => {
		const { failures, checked } = lintLockfileRanges(fixture("match"));
		assert.deepEqual(failures, []);
		assert.equal(checked, 1);
	});

	it("fails on a range mismatch and names path, package and both values", () => {
		const { failures } = lintLockfileRanges(fixture("mismatch"));
		assert.deepEqual(failures, ["providers/aws: @launchfile/sdk recorded ^0.12.0, declared ^0.13.0"]);
	});

	it("fails when an internal dep is declared but not recorded", () => {
		const { failures } = lintLockfileRanges(fixture("missing"));
		assert.equal(failures.length, 1);
		assert.match(failures[0], /providers\/aws: @launchfile\/sdk declared \^0\.13\.0.*not recorded/);
	});

	it("fails when an internal dep is recorded but not declared", () => {
		const { failures } = lintLockfileRanges(fixture("extra"));
		assert.equal(failures.length, 1);
		assert.match(failures[0], /providers\/aws: @launchfile\/sdk recorded \^0\.13\.0.*not declared/);
	});

	it("fails when a recorded member version differs from package.json", () => {
		const { failures } = lintLockfileRanges(fixture("version"));
		assert.deepEqual(failures, ["sdk: version recorded 0.12.0, declared 0.13.0"]);
	});

	it("throws instead of passing when there are no internal ranges", () => {
		assert.throws(() => lintLockfileRanges(fixture("none")), LintError);
	});

	it("throws instead of passing when bun.lock does not parse", () => {
		assert.throws(() => lintLockfileRanges(fixture("badparse")), /cannot parse/);
	});
});
