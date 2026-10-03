/**
 * `requires[].version` on the aws probe (PROVIDERS.md §10 item 8, D-next).
 * The probe emits `engine_version` only for a version it can pass through
 * unchanged, never a string carved out of a range, and records every range it
 * does not meet as a conformance gap.
 */

import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { translate } from "../translate.js";

function tf(type: string, version?: string) {
	const versionLine = version
		? `\n    version: ${JSON.stringify(version)}`
		: "";
	return translate(
		readLaunch(`
version: launch/v1
name: my-app
runtime: node
commands:
  start: "node server.js"
requires:
  - type: ${type}${versionLine}
`),
	);
}

const versionGaps = (result: ReturnType<typeof tf>) =>
	result.conformance.gaps.filter((g) => g.field.endsWith(".version"));

describe("aws requires[].version on RDS engines", () => {
	it("passes a bare major version through as engine_version and records no gap", () => {
		const result = tf("postgres", "16");
		expect(result.hcl).toMatch(/engine_version\s*=\s*"16"/);
		expect(versionGaps(result)).toEqual([]);
	});

	it("passes a bare major.minor version through unchanged", () => {
		const result = tf("mysql", "8.0");
		expect(result.hcl).toMatch(/engine_version\s*=\s*"8.0"/);
		expect(versionGaps(result)).toEqual([]);
	});

	for (const [type, range] of [
		["postgres", ">=9.6"],
		["postgres", "^7.0"],
		["postgres", "20.x"],
		["mysql", ">=8"],
		["mariadb", "~10.11"],
	] as const) {
		it(`emits no engine_version for the ${type} range ${range} and records the gap`, () => {
			const result = tf(type, range);
			expect(result.hcl).not.toContain("engine_version");
			expect(versionGaps(result)).toEqual([
				{
					field: `requires:${type}.version`,
					severity: "workaround",
					reason: `declared version ${JSON.stringify(range)} is a range this probe does not resolve to an engine version; it emits no engine_version, so RDS uses its default ${type} version`,
					suggestion: `set engine_version on aws_db_instance.my_app_${type} to an RDS ${type} version that satisfies ${JSON.stringify(range)}`,
					component: undefined,
				},
			]);
		});
	}

	it("never invents a version for a string with no digits", () => {
		const result = tf("postgres", "latest");
		expect(result.hcl).not.toContain("engine_version");
		expect(versionGaps(result)[0]?.reason).toContain(
			"is not a valid semver range",
		);
	});

	it("emits no engine_version and no gap when no version is declared", () => {
		const result = tf("postgres");
		expect(result.hcl).not.toContain("engine_version");
		expect(versionGaps(result)).toEqual([]);
	});
});

describe("aws requires[].version on ElastiCache redis", () => {
	it("records nothing when the Redis 7 family satisfies the range", () => {
		expect(versionGaps(tf("redis", ">=6"))).toEqual([]);
	});

	it("records a gap when the Redis 7 family cannot satisfy the range", () => {
		const [gap] = versionGaps(tf("redis", ">=8"));
		expect(gap?.field).toBe("requires:redis.version");
		expect(gap?.reason).toBe(
			'declared version ">=8" is not satisfied: this probe emits a Redis 7 cluster (parameter group default.redis7, any 7.x) and selects no other version',
		);
	});

	it("records a gap when the Redis 7 family only partly overlaps the range", () => {
		const [gap] = versionGaps(tf("redis", "^7.2"));
		expect(gap?.reason).toContain(
			'declared version "^7.2" cannot be checked against a Redis 7 cluster',
		);
	});

	it("emits no engine_version for redis", () => {
		expect(tf("redis", "7").hcl).not.toContain("engine_version");
	});
});
