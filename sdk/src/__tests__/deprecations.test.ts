/**
 * D-54 / D-42: the deprecation registry is the mechanism, not one special
 * case. These tests guard the two properties that make it one — the SDK
 * registry and the JSON Schema annotations stay in lockstep, and no
 * deprecation can ship half-annotated.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEPRECATED_IN,
	DEPRECATION_REGISTRY,
	lintDeprecations,
	REMOVED_IN,
} from "../deprecations.js";
import { readLaunch } from "../reader.js";

const SDK_ROOT = resolve(import.meta.dirname ?? __dirname, "..", "..");
const SCHEMA_PATH = resolve(
	SDK_ROOT,
	"..",
	"spec",
	"schema",
	"launchfile.schema.json",
);
const PUBLISHED_SCHEMA_PATH = resolve(
	SDK_ROOT,
	"..",
	"www-dev",
	"public",
	"schema",
	"v1",
);

const schemaText = readFileSync(SCHEMA_PATH, "utf-8");
const schema = JSON.parse(schemaText) as Record<string, unknown>;

/** The four D-42 semantic parts every deprecation must carry. */
const D42_PARTS = ["deprecated_in", "removed_in", "replacement", "hint"] as const;

/** Resolve a JSON Pointer (the `#/a/b` subset the registry uses). */
function pointer(root: unknown, ptr: string): unknown {
	let current = root;
	for (const raw of ptr.replace(/^#\//, "").split("/")) {
		const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/** Every subschema in the document carrying `deprecated: true`, by pointer. */
function deprecatedNodes(
	node: unknown,
	ptr = "#",
	out: Array<{ ptr: string; node: Record<string, unknown> }> = [],
): Array<{ ptr: string; node: Record<string, unknown> }> {
	if (node === null || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		node.forEach((child, i) => {
			deprecatedNodes(child, `${ptr}/${i}`, out);
		});
		return out;
	}
	const obj = node as Record<string, unknown>;
	if (obj.deprecated === true) out.push({ ptr, node: obj });
	for (const [key, value] of Object.entries(obj)) {
		deprecatedNodes(value, `${ptr}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, out);
	}
	return out;
}

describe("deprecation metadata in the JSON Schema", () => {
	// Test 8 — the structural guard: the NEXT deprecation cannot ship
	// half-annotated, whatever it deprecates.
	it("gives every deprecated node a complete x-launchfile-deprecation object", () => {
		const nodes = deprecatedNodes(schema);
		expect(nodes.length).toBeGreaterThan(0);
		for (const { ptr, node } of nodes) {
			const meta = node["x-launchfile-deprecation"];
			expect(meta, `${ptr} carries no x-launchfile-deprecation`).toBeTypeOf(
				"object",
			);
			for (const part of D42_PARTS) {
				const value = (meta as Record<string, unknown>)[part];
				expect(value, `${ptr} is missing ${part}`).toBeTypeOf("string");
				expect((value as string).length, `${ptr}.${part} is empty`).toBeGreaterThan(0);
			}
		}
	});

	it("uses only launch/vN format versions (D-17) and removes at a major (P-14)", () => {
		for (const { ptr, node } of deprecatedNodes(schema)) {
			const meta = node["x-launchfile-deprecation"] as Record<string, string>;
			const deprecatedIn = meta.deprecated_in ?? "";
			const removedIn = meta.removed_in ?? "";
			expect(deprecatedIn, ptr).toMatch(/^launch\/v\d+$/);
			expect(removedIn, ptr).toMatch(/^launch\/v\d+$/);
			expect(Number(removedIn.slice("launch/v".length)), ptr).toBeGreaterThan(
				Number(deprecatedIn.slice("launch/v".length)),
			);
		}
	});

	it("keeps the SDK registry and the schema annotations in lockstep", () => {
		const nodes = deprecatedNodes(schema);
		expect(DEPRECATION_REGISTRY.map((r) => r.schema_pointer).sort()).toEqual(
			nodes.map((n) => n.ptr).sort(),
		);
		for (const record of DEPRECATION_REGISTRY) {
			const node = pointer(schema, record.schema_pointer) as Record<string, unknown>;
			expect(node, record.schema_pointer).toBeDefined();
			expect(node.deprecated).toBe(true);
			expect(node["x-launchfile-deprecation"]).toEqual({
				deprecated_in: record.deprecated_in,
				removed_in: record.removed_in,
				replacement: record.replacement,
				hint: record.hint,
			});
		}
	});

	// Test 9 — the published copy at launchfile.dev/schema/v1 is what every
	// catalog file's `# yaml-language-server: $schema=` directive resolves to.
	// Nothing else keeps the two files in sync.
	it("keeps www-dev/public/schema/v1 byte-identical to the spec schema", () => {
		expect(readFileSync(PUBLISHED_SCHEMA_PATH, "utf-8")).toBe(schemaText);
	});

	// D-54 leaves every legacy key structurally untouched — the deprecation is
	// annotation-only, so existing files stay hard-valid (P-13).
	it("changes nothing structural under $defs.host", () => {
		const host = pointer(schema, "#/$defs/host") as Record<string, unknown>;
		expect(host.type).toBe("object");
		expect(host.additionalProperties).toBe(false);
		expect(host.required).toBeUndefined();
		const props = host.properties as Record<string, Record<string, unknown>>;
		expect(Object.keys(props).sort()).toEqual([
			"docker",
			"filesystem",
			"network",
			"privileged",
		]);
		expect(props.docker!.enum).toEqual(["required", "optional"]);
		expect(props.network!.enum).toEqual(["host", "bridge"]);
		expect(props.filesystem!.enum).toEqual(["read-write", "read-only", "none"]);
		expect(props.privileged!.type).toBe("boolean");
	});
});

describe("lintDeprecations", () => {
	it("reports the block and every key present, with all four D-42 parts", () => {
		const found = lintDeprecations(
			readLaunch(`
name: legacy
image: app:1
host:
  docker: required
  network: host
  filesystem: read-write
`),
		);
		expect(found.map((d) => d.path)).toEqual([
			"components.default.host",
			"components.default.host.docker",
			"components.default.host.filesystem",
			"components.default.host.network",
		]);
		for (const d of found) {
			expect(d.deprecated_in).toBe(DEPRECATED_IN);
			expect(d.removed_in).toBe(REMOVED_IN);
			expect(d.replacement.length).toBeGreaterThan(0);
			expect(d.hint.length).toBeGreaterThan(0);
		}
	});

	it("reports a key set to its default value — the key is still deprecated", () => {
		const found = lintDeprecations(
			readLaunch("name: legacy\nimage: app:1\nhost:\n  network: bridge\n"),
		);
		expect(found.map((d) => d.path)).toEqual([
			"components.default.host",
			"components.default.host.network",
		]);
		expect(found[1]!.hint).toContain("drop the key");
	});

	it("names the component a top-level block inherits into (D-25)", () => {
		const found = lintDeprecations(
			readLaunch(`
name: multi
host:
  privileged: true
components:
  api:
    image: api:1
  worker:
    image: worker:1
`),
		);
		expect(found.map((d) => d.path)).toEqual([
			"components.api.host",
			"components.api.host.privileged",
			"components.worker.host",
			"components.worker.host.privileged",
		]);
	});

	it("reports nothing for a file with no host block at all", () => {
		expect(
			lintDeprecations(readLaunch("name: plain\nimage: app:1\n")),
		).toEqual([]);
	});
});
