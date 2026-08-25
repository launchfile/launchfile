/**
 * The deprecation registry and reporter — D-42's mechanism, first applied by
 * D-54 to the legacy top-level `host:` block.
 *
 * Deprecations are DATA, not code: adding one is an entry in
 * {@link DEPRECATION_REGISTRY} plus the matching JSON Schema annotations, with
 * no change to the walker below. Each entry carries D-42's four semantic parts
 * (`deprecated_in`, `removed_in`, `replacement`, `hint`) and the JSON Pointer
 * of the schema node it mirrors, so the two copies are testably in lockstep.
 *
 * Reporting only. Nothing here rewrites a file, and a deprecation never makes
 * a file invalid: deprecation warns, removal migrates, nothing breaks (P-14).
 */

import type { NormalizedLaunch } from "./types.js";

/** Format version the deprecated field is still valid in (D-17 vocabulary). */
export const DEPRECATED_IN = "launch/v1";

/** Format version that removes the deprecated field — always a major (P-14). */
export const REMOVED_IN = "launch/v2";

/**
 * One machine-readable deprecation finding: D-42's four parts, plus where in
 * the file the deprecated field was found.
 */
export interface Deprecation {
	/** Dotted location in the normalized file, e.g. `components.default.host.docker`. */
	path: string;
	/** Format version the field was deprecated in. */
	deprecated_in: string;
	/** Format version that removes it. */
	removed_in: string;
	/** Field path that replaces it. */
	replacement: string;
	/** Human-readable migration instruction. */
	hint: string;
}

/** A registry entry: one deprecated field and how to migrate off it. */
export interface DeprecationRecord {
	/**
	 * Dotted field path relative to a component, e.g. `host` or `host.docker`.
	 * A finding is emitted for every component in which this path is present.
	 */
	field: string;
	/** JSON Pointer of the schema node carrying the same annotation. */
	schema_pointer: string;
	deprecated_in: string;
	removed_in: string;
	replacement: string;
	hint: string;
}

/**
 * Every deprecation the format currently declares. Kept byte-identical in its
 * four semantic parts to the `x-launchfile-deprecation` annotations in
 * `spec/schema/launchfile.schema.json` — `deprecations.test.ts` asserts it.
 */
export const DEPRECATION_REGISTRY: readonly DeprecationRecord[] = [
	{
		field: "host",
		schema_pointer: "#/$defs/host",
		deprecated_in: DEPRECATED_IN,
		removed_in: REMOVED_IN,
		replacement: "requires[].host / supports[].host",
		hint:
			"Replace the `host:` block with host-capability entries: each key becomes a " +
			"`- host: { <capability>: <value> }` entry under `requires` (or `supports` when " +
			"optional). See SPEC.md § Host for the per-key table.",
	},
	{
		field: "host.docker",
		schema_pointer: "#/$defs/host/properties/docker",
		deprecated_in: DEPRECATED_IN,
		removed_in: REMOVED_IN,
		replacement: "requires[].host.container_runtime",
		hint:
			"Replace `host: { docker: required }` with `requires: [ - host: { container_runtime: docker } ]`. " +
			"For `optional`, put the same entry under `supports`.",
	},
	{
		field: "host.network",
		schema_pointer: "#/$defs/host/properties/network",
		deprecated_in: DEPRECATED_IN,
		removed_in: REMOVED_IN,
		replacement: "requires[].host.network",
		hint:
			"Replace `host: { network: host }` with `requires: [ - host: { network: host } ]`. " +
			"`bridge` is the default — drop the key instead of writing an entry.",
	},
	{
		field: "host.filesystem",
		schema_pointer: "#/$defs/host/properties/filesystem",
		deprecated_in: DEPRECATED_IN,
		removed_in: REMOVED_IN,
		replacement: "requires[].host.filesystem",
		hint:
			"Replace `host: { filesystem: read-write }` with `requires: [ - host: { filesystem: read-write } ]`. " +
			"`none` is the default — drop the key instead of writing an entry.",
	},
	{
		field: "host.privileged",
		schema_pointer: "#/$defs/host/properties/privileged",
		deprecated_in: DEPRECATED_IN,
		removed_in: REMOVED_IN,
		replacement: "requires[].host.privileged",
		hint:
			"Replace `host: { privileged: true }` with `requires: [ - host: { privileged: true } ]`. " +
			"`false` is the default — drop the key instead of writing an entry.",
	},
];

/**
 * Resolve a dotted field path against a component. Returns `undefined` when
 * any segment is absent, so presence is `!== undefined` — a key set to its
 * default value (`network: bridge`) is still present, and still deprecated.
 */
function valueAt(component: unknown, field: string): unknown {
	let current: unknown = component;
	for (const segment of field.split(".")) {
		if (current === null || typeof current !== "object") return undefined;
		if (!Object.hasOwn(current as object, segment)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * Report every deprecated field present in a normalized Launch (D-42
 * capability (a)), machine-readably. Findings are ordered by path so output is
 * stable; an empty array means the file uses no deprecated field.
 *
 * A top-level `host:` block inherits into every component (D-25), so a
 * multi-component file reports it once per component — the path names exactly
 * where the normalized model carries it.
 *
 * This never affects validity and never changes an exit code.
 */
export function lintDeprecations(launch: NormalizedLaunch): Deprecation[] {
	const found: Deprecation[] = [];
	for (const [componentName, component] of Object.entries(launch.components)) {
		for (const record of DEPRECATION_REGISTRY) {
			if (valueAt(component, record.field) === undefined) continue;
			found.push({
				path: `components.${componentName}.${record.field}`,
				deprecated_in: record.deprecated_in,
				removed_in: record.removed_in,
				replacement: record.replacement,
				hint: record.hint,
			});
		}
	}
	return found.sort((a, b) => a.path.localeCompare(b.path));
}
