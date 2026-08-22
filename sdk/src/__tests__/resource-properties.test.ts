import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RESOURCE_PROPERTY_VOCABULARY } from "../resource-properties.js";

/**
 * Single-source-of-truth guard (D-45): the vocabulary exists in three forms —
 * the SPEC.md prose table (canonical, human-governed), the machine-readable
 * registry `spec/schema/resource-properties.json`, and the SDK's runtime
 * module. This suite parses the SPEC.md table as ground truth and asserts the
 * other two match it exactly, so any drift between the copies fails CI.
 *
 * Direction: SPEC.md is parsed rather than generated because the prose table
 * is the ratified document — deriving it from JSON would couple the spec's
 * wording and formatting to build tooling, while parsing a pipe table of
 * backticked identifiers is trivial and stable.
 */

const specPath = fileURLToPath(
	new URL("../../../spec/SPEC.md", import.meta.url),
);
const registryPath = fileURLToPath(
	new URL("../../../spec/schema/resource-properties.json", import.meta.url),
);

/** Parse SPEC.md's "Resource Property Vocabulary" table → type → properties. */
function parseSpecVocabulary(): Record<string, string[]> {
	const spec = readFileSync(specPath, "utf8");
	const sectionStart = spec.indexOf("## Resource Property Vocabulary");
	expect(sectionStart).toBeGreaterThan(-1);
	const rest = spec.slice(sectionStart + 2);
	const sectionEnd = rest.indexOf("\n## ");
	const section = sectionEnd === -1 ? rest : rest.slice(0, sectionEnd);

	const vocabulary: Record<string, string[]> = {};
	for (const line of section.split("\n")) {
		const row = /^\|\s*`([a-z0-9_]+)`\s*\|(.+)\|\s*$/.exec(line);
		if (!row) continue;
		const properties = [...row[2]!.matchAll(/`([a-z0-9_]+)`/g)].map(
			(m) => m[1]!,
		);
		vocabulary[row[1]!] = properties;
	}
	return vocabulary;
}

describe("resource property registry consistency (D-45)", () => {
	const specVocabulary = parseSpecVocabulary();

	it("parses all 12 resource types from the SPEC.md table", () => {
		expect(Object.keys(specVocabulary).sort()).toEqual(
			[
				"clickhouse",
				"elasticsearch",
				"kafka",
				"memcache",
				"minio",
				"mongodb",
				"mysql",
				"postgres",
				"rabbitmq",
				"redis",
				"s3",
				"sqlite",
			].sort(),
		);
	});

	it("spec/schema/resource-properties.json matches the SPEC.md table exactly", () => {
		const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
			types: Record<string, Record<string, string>>;
		};
		const registryVocabulary = Object.fromEntries(
			Object.entries(registry.types).map(([type, props]) => [
				type,
				Object.keys(props),
			]),
		);
		expect(registryVocabulary).toEqual(specVocabulary);
	});

	it("registry semantics are one-line descriptions for every property", () => {
		const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
			types: Record<string, Record<string, string>>;
		};
		for (const props of Object.values(registry.types)) {
			for (const semantics of Object.values(props)) {
				expect(semantics.length).toBeGreaterThan(0);
				expect(semantics).not.toContain("\n");
			}
		}
	});

	it("the SDK's runtime vocabulary matches the SPEC.md table exactly", () => {
		const sdkVocabulary = Object.fromEntries(
			Object.entries(RESOURCE_PROPERTY_VOCABULARY).map(([type, props]) => [
				type,
				[...props],
			]),
		);
		expect(sdkVocabulary).toEqual(specVocabulary);
	});
});
