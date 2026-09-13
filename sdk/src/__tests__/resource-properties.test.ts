import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	isRepeatableUse,
	RESOURCE_PROPERTY_VOCABULARY,
	RESOURCE_USE_VOCABULARY,
} from "../resource-properties.js";

/**
 * Single-source-of-truth guard (D-46): the vocabulary exists in three forms —
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
		// Type and property identifiers admit `-` as well as `_`: the vocabulary
		// carries `https-origin` alongside the underscored `access_key` family.
		const row = /^\|\s*`([a-z0-9_-]+)`\s*\|(.+)\|\s*$/.exec(line);
		if (!row) continue;
		const properties = [...row[2]!.matchAll(/`([a-z0-9_-]+)`/g)].map(
			(m) => m[1]!,
		);
		vocabulary[row[1]!] = properties;
	}
	return vocabulary;
}

/**
 * Parse SPEC.md's "Resource Use Vocabulary" table → type → use → registered
 * properties. Its own parser, because the property-vocabulary parser above is
 * keyed to a two-column table and this one carries a use column and a
 * registers column; a `—` in the registers cell means the use registers
 * nothing.
 */
/** One row of the SPEC.md use table: the keys the use registers and its Repeatable column. */
interface SpecUseRow {
	registers: string[];
	repeatable: boolean;
}

function parseSpecUseTable(): Record<string, Record<string, SpecUseRow>> {
	const spec = readFileSync(specPath, "utf8");
	const sectionStart = spec.indexOf("## Resource Use Vocabulary");
	expect(sectionStart).toBeGreaterThan(-1);
	const rest = spec.slice(sectionStart + 2);
	const sectionEnd = rest.indexOf("\n## ");
	const section = sectionEnd === -1 ? rest : rest.slice(0, sectionEnd);

	const table: Record<string, Record<string, SpecUseRow>> = {};
	for (const line of section.split("\n")) {
		const row =
			/^\|\s*`([a-z0-9_-]+)`\s*\|\s*`([a-z0-9_-]+)`\s*\|([^|]*)\|\s*(yes|no)\s*\|/.exec(line);
		if (!row) continue;
		const registers = [...row[3]!.matchAll(/`([a-z0-9_-]+)`/g)].map((m) => m[1]!);
		(table[row[1]!] ??= {})[row[2]!] = { registers, repeatable: row[4] === "yes" };
	}
	return table;
}

function parseSpecUseVocabulary(): Record<string, Record<string, string[]>> {
	return Object.fromEntries(
		Object.entries(parseSpecUseTable()).map(([type, uses]) => [
			type,
			Object.fromEntries(Object.entries(uses).map(([use, row]) => [use, row.registers])),
		]),
	);
}

describe("resource property registry consistency (D-46)", () => {
	const specVocabulary = parseSpecVocabulary();

	it("parses all 14 resource types from the SPEC.md table", () => {
		expect(Object.keys(specVocabulary).sort()).toEqual(
			[
				"certificate",
				"clickhouse",
				"elasticsearch",
				"https-origin",
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

describe("resource use registry consistency", () => {
	const specUses = parseSpecUseVocabulary();

	interface UseRegistry {
		uses: Record<
			string,
			Record<string, { description: string; properties: Record<string, string>; repeatable: boolean }>
		>;
	}
	const registry = JSON.parse(readFileSync(registryPath, "utf8")) as UseRegistry;
	const registryUses = Object.fromEntries(
		Object.entries(registry.uses)
			.filter(([key]) => !key.startsWith("$"))
			.map(([type, uses]) => [
				type,
				Object.fromEntries(
					Object.entries(uses).map(([use, entry]) => [use, Object.keys(entry.properties)]),
				),
			]),
	);

	it("parses the three typed use vocabularies from the SPEC.md table", () => {
		expect(Object.keys(specUses).sort()).toEqual(["mysql", "postgres", "redis"]);
		expect(specUses.redis).toEqual({ db: ["url", "index"], pubsub: [], server: [] });
	});

	it("the uses key of spec/schema/resource-properties.json matches the SPEC.md table exactly", () => {
		expect(registryUses).toEqual(specUses);
	});

	it("the SDK's runtime use vocabulary matches the SPEC.md table exactly", () => {
		const sdkUses = Object.fromEntries(
			Object.entries(RESOURCE_USE_VOCABULARY).map(([type, uses]) => [
				type,
				Object.fromEntries(Object.entries(uses).map(([use, props]) => [use, [...props]])),
			]),
		);
		expect(sdkUses).toEqual(specUses);
	});

	it("every registered use carries a one-line description and a repeatable flag", () => {
		for (const [type, uses] of Object.entries(registry.uses)) {
			if (type.startsWith("$")) continue;
			for (const entry of Object.values(uses)) {
				expect(entry.description.length).toBeGreaterThan(0);
				expect(entry.description).not.toContain("\n");
				expect(typeof entry.repeatable).toBe("boolean");
				for (const semantics of Object.values(entry.properties)) {
					expect(semantics.length).toBeGreaterThan(0);
					expect(semantics).not.toContain("\n");
				}
			}
		}
	});

	it("marks db and database repeatable, and nothing else", () => {
		const repeatable: string[] = [];
		for (const [type, uses] of Object.entries(registry.uses)) {
			if (type.startsWith("$")) continue;
			for (const [use, entry] of Object.entries(uses)) {
				if (entry.repeatable) repeatable.push(`${type}.${use}`);
			}
		}
		expect(repeatable.sort()).toEqual(["mysql.database", "postgres.database", "redis.db"]);
	});

	it("the SPEC.md Repeatable column, the registry flag and isRepeatableUse agree on every use", () => {
		const table = parseSpecUseTable();
		expect(Object.keys(table).sort()).toEqual(["mysql", "postgres", "redis"]);
		for (const [type, uses] of Object.entries(table)) {
			for (const [use, row] of Object.entries(uses)) {
				expect(registry.uses[type]?.[use]?.repeatable, `${type}.${use}`).toBe(row.repeatable);
				expect(isRepeatableUse(type, use), `${type}.${use}`).toBe(row.repeatable);
			}
		}
	});

	it("isRepeatableUse has no answer for a type or token outside the registry (L-4)", () => {
		expect(isRepeatableUse("kafka", "topic")).toBeUndefined();
		expect(isRepeatableUse("redis", "streams")).toBeUndefined();
		expect(isRepeatableUse("constructor", "db")).toBeUndefined();
	});

	it("uses is a sibling of types, never a member", () => {
		const raw = JSON.parse(readFileSync(registryPath, "utf8")) as { types: Record<string, unknown> };
		expect(raw.types).not.toHaveProperty("uses");
	});

	it("keeps the use map free of inherited keys", () => {
		expect(RESOURCE_USE_VOCABULARY.constructor).toBeUndefined();
		expect(RESOURCE_USE_VOCABULARY.redis!.constructor).toBeUndefined();
	});
});
