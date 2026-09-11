import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { launchToCompose } from "../compose-generator.js";

/**
 * PROVIDERS.md §10 rule 8 (general form): a field this provider cannot honor
 * is surfaced, never silently dropped. This provider provisions fixed image
 * tags and never selects a version, so a declared `requires[].version` is
 * compared against the tag the deployment actually runs.
 *
 * Honoring is silent: a tag that provably satisfies the range is not a gap,
 * and warning there would train authors to ignore the channel (the D-51
 * standard — say what this provider does, never predict the app).
 */
describe("requires[].version constraint reporting", () => {
	const compose = (requires: string) =>
		launchToCompose(
			readLaunch(
				`version: launch/v1\nname: app\nimage: x:1\nrequires:\n${requires}`,
			),
		);

	const versionWarnings = (requires: string) =>
		compose(requires).warnings.filter((w) => w.includes("declared version"));

	it("stays silent when the pinned image satisfies the range", () => {
		// postgres:16-alpine covers every 16.x, all of which are >= 15.
		expect(versionWarnings('  - type: postgres\n    version: ">=15"\n')).toEqual(
			[],
		);
	});

	it("warns when the pinned image cannot satisfy the range", () => {
		const [warning] = versionWarnings(
			'  - type: postgres\n    version: ">=17"\n',
		);
		expect(warning).toContain('requires[postgres]: declared version ">=17"');
		expect(warning).toContain("is not satisfied");
		expect(warning).toContain("postgres:16-alpine");
	});

	it("warns when the tag is too coarse to decide the range", () => {
		// `16` names the whole 16.x family; ^16.2 excludes 16.0 and 16.1.
		const [warning] = versionWarnings(
			'  - type: postgres\n    version: "^16.2"\n',
		);
		expect(warning).toContain("cannot be checked against the fixed image");
		expect(warning).toContain("postgres:16-alpine");
	});

	it("warns when the image tag names no version", () => {
		const [warning] = versionWarnings(
			'  - type: clickhouse\n    version: ">=24"\n',
		);
		expect(warning).toContain("clickhouse/clickhouse-server:latest");
		expect(warning).toContain("whose version is not fixed");
	});

	it("warns on a range it cannot parse rather than dropping it", () => {
		const [warning] = versionWarnings(
			'  - type: redis\n    version: "seven-ish"\n',
		);
		expect(warning).toContain("is not a valid semver range");
		expect(warning).toContain("redis:7-alpine");
	});

	it("names the entry by its `name` when one is given", () => {
		const [warning] = versionWarnings(
			'  - type: postgres\n    name: primary-db\n    version: ">=17"\n',
		);
		expect(warning).toContain("requires[primary-db]:");
	});

	it("checks every backing-service type, not postgres alone", () => {
		for (const [type, image] of [
			["mysql", "mysql:8"],
			["mariadb", "mariadb:11"],
			["redis", "redis:7-alpine"],
			["mongodb", "mongo:7"],
		] as const) {
			const [warning] = versionWarnings(
				`  - type: ${type}\n    version: ">=99"\n`,
			);
			expect(warning).toContain(`requires[${type}]:`);
			expect(warning).toContain(image);
		}
	});

	it("stays silent for an entry that declares no version", () => {
		expect(versionWarnings("  - type: postgres\n")).toEqual([]);
	});

	it("checks the substituted extension image, not the default one", () => {
		// `config.extensions` swaps the image; the check must run against what
		// the compose file actually carries.
		const requires =
			'  - type: postgres\n    version: ">=17"\n    config:\n      extensions: [pgvector]\n';
		const [warning] = versionWarnings(requires);
		expect(warning).toContain("pgvector/pgvector:pg16");
		expect(warning).not.toContain("postgres:16-alpine");
	});

	it("stays silent when the substituted extension image satisfies the range", () => {
		const requires =
			'  - type: postgres\n    version: ">=15"\n    config:\n      extensions: [pgvector]\n';
		expect(versionWarnings(requires)).toEqual([]);
	});
});

/**
 * The three shipped entries that declare `requires[].version` all state lower
 * bounds the pinned major already clears. None is mis-provisioned today, so
 * none may warn — this is what keeps the check from becoming noise on files
 * that are correct.
 */
describe("shipped catalog entries declaring requires[].version", () => {
	const CATALOG = join(import.meta.dirname, "../../../../catalog");

	for (const entry of [
		"apps/hedgedoc",
		"drafts/hedgedoc-v2",
		"drafts/plausible",
	]) {
		it(`${entry} generates no version warning`, async () => {
			const yaml = await readFile(join(CATALOG, entry, "Launchfile"), "utf8");
			const { warnings } = launchToCompose(readLaunch(yaml));
			expect(warnings.filter((w) => w.includes("declared version"))).toEqual(
				[],
			);
		});
	}
});
