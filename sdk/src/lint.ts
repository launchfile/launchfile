/**
 * Non-fatal lint checks over a normalized Launch.
 *
 * These complement the hard schema validation in {@link readLaunch}: a file can
 * be schema-valid yet still contain footguns worth surfacing. Like the
 * providers' warning channel, a lint result is a flat `string[]` of
 * human-readable messages — empty means clean. Lint never throws and never
 * rejects a file; it only advises.
 */

import { parseExpression } from "./resolver.js";
import { RESOURCE_PROPERTY_VOCABULARY } from "./resource-properties.js";
import { lintDurations } from "./durations.js";
import type { NormalizedLaunch, NormalizedRequirement } from "./types.js";

export type { Deprecation, DeprecationRecord } from "./deprecations.js";
// Deprecation reporting is a lint check, but its findings are structured
// (D-42 requires machine-readable, and a prose string is not), so it has its
// own return type and its own channel out of `validate` — see deprecations.ts.
export {
	DEPRECATED_IN,
	DEPRECATION_REGISTRY,
	lintDeprecations,
	REMOVED_IN,
} from "./deprecations.js";

/** Reserved expression namespaces — never resource properties. */
const RESERVED_NAMESPACES = new Set([
	"app",
	"secrets",
	"components",
	"storage",
]);

/** A resource declaration seen at a particular location, for conflict reporting. */
interface ResourceDecl {
	/** Where it was declared (component name, or "(top-level)"). */
	where: string;
	req: NormalizedRequirement;
}

/** Stable string form of a `config` object for divergence comparison. */
function configKey(config: Record<string, unknown> | undefined): string {
	if (!config) return "";
	// Sort keys so declaration order doesn't register as a divergence.
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(config).sort()) sorted[key] = config[key];
	return JSON.stringify(sorted);
}

/**
 * Resolve the name a resource declaration binds to. Per D-24, `name` defaults
 * to `type` when omitted, so two entries that omit `name` and share a `type`
 * resolve to the same resource.
 */
function resourceName(req: NormalizedRequirement): string {
	return req.name ?? req.type;
}

/**
 * Capability names a host-capability entry can carry (D-44). Used only for
 * the marker-enforcement advisory: a backing-service entry whose `type` is
 * one of these almost certainly meant to be a `host:`-marked capability.
 * The real vocabulary is open (L-4) — this set only powers the warning.
 */
const KNOWN_HOST_CAPABILITIES = new Set([
	"container_runtime",
	"network",
	"filesystem",
	"privileged",
]);

/**
 * Product-named spellings a pre-D-44 file actually writes, mapped to the
 * interface that replaces them. Suggesting `host: { docker: … }` would trade
 * one P-1 violation for another — the marker is only half the fix; naming an
 * interface rather than a product is the other half.
 */
const PRODUCT_SPELLINGS: Record<string, string> = {
	docker: "container_runtime: docker",
	"docker.sock": "container_runtime: docker",
	podman: "container_runtime: docker",
};

/**
 * Extract every bare single-segment reference (`$prop` / `${prop}` /
 * `${prop:-default}`) from a set_env value. Bare references always target the
 * enclosing resource, so the resource type is unambiguous. Multi-segment
 * references (`$name.prop`, `$components.x.url`, …) are excluded: their first
 * segment names a namespace or another resource, not a property of this one.
 */
function bareReferences(value: string): string[] {
	const parsed = parseExpression(value);
	const refs: { path: string[] }[] =
		parsed.kind === "reference"
			? [parsed]
			: parsed.kind === "template"
				? parsed.parts.filter(
						(p): p is { kind: "ref"; path: string[] } => p.kind === "ref",
					)
				: [];
	return refs
		.filter((r) => r.path.length === 1 && !RESERVED_NAMESPACES.has(r.path[0]!))
		.map((r) => r.path[0]!);
}

/**
 * D-46 check: for each set_env expression on a requirement whose type is in
 * the standard vocabulary (SPEC.md § Resource Property Vocabulary), warn when
 * a bare property reference is outside that type's known set. Known-type
 * vocabularies are open — a provider extension is legitimate — so the copy is
 * advisory ("not in the standard vocabulary"), never an accusation of
 * invalidity. Unknown resource types are fully open (L-4) and stay silent.
 */
function checkResourceProperties(
	launch: NormalizedLaunch,
	warnings: string[],
): void {
	for (const component of Object.values(launch.components)) {
		for (const req of [
			...(component.requires ?? []),
			...(component.supports ?? []),
		]) {
			// req.type is arbitrary user input (L-4). A bare index would resolve
			// Object.prototype keys (constructor, toString, …) to inherited values.
			const vocabulary = Object.hasOwn(RESOURCE_PROPERTY_VOCABULARY, req.type)
				? RESOURCE_PROPERTY_VOCABULARY[req.type]
				: undefined;
			if (!vocabulary || !req.set_env) continue;
			for (const value of Object.values(req.set_env)) {
				for (const prop of bareReferences(value)) {
					if (vocabulary.includes(prop)) continue;
					warnings.push(
						`"$${prop}" is not in the standard vocabulary for ${req.type} ` +
							`(known: ${vocabulary.join(", ")})`,
					);
				}
			}
		}
	}
}

/**
 * Lint a normalized Launch, returning non-fatal warning strings (empty = clean).
 *
 * Checks:
 * - (Q1) when two `requires`/`supports` entries across all components (and any
 *   single-component top-level fields, which normalize into the "default"
 *   component) resolve to the SAME resource name (D-24) but declare DIVERGENT
 *   `type`, `version`, or `config`, a single warning per conflicting resource
 *   names the field(s) that diverge. Same name + identical definition is
 *   normal resource sharing and is not warned about. Host-capability entries
 *   (D-44) are not resources and are excluded from this grouping.
 * - (D-44 marker enforcement, advisory) a backing-service entry whose `type`
 *   names a known host capability is warned about: host capabilities require
 *   the `host:` marker so the privilege surface stays machine-extractable.
 * - Non-standard resource properties (D-46): see {@link checkResourceProperties}.
 *
 * Also checks every duration-valued field against the ratified duration
 * grammar — see {@link lintDurations}.
 */
export function lintLaunch(launch: NormalizedLaunch): string[] {
	const warnings: string[] = [...lintDurations(launch)];

	// Collect every requires/supports declaration grouped by resolved name.
	const byName = new Map<string, ResourceDecl[]>();
	for (const [componentName, component] of Object.entries(launch.components)) {
		const where = componentName === "default" ? "(top-level)" : componentName;
		for (const req of [
			...(component.requires ?? []),
			...(component.supports ?? []),
		]) {
			if (req.host) continue; // capability entry, not a resource (D-44)
			// Guarded for the same reason as the vocabulary lookup above.
			const productSpelling = Object.hasOwn(PRODUCT_SPELLINGS, req.type)
				? PRODUCT_SPELLINGS[req.type]
				: undefined;
			if (productSpelling || KNOWN_HOST_CAPABILITIES.has(req.type)) {
				const suggestion = productSpelling ?? `${req.type}: ...`;
				warnings.push(
					`${where}: "${req.type}" looks like a host capability — the host: marker is ` +
						`required on privileged entries (D-44): use \`- host: { ${suggestion} }\``,
				);
				continue;
			}
			const name = resourceName(req);
			const decls = byName.get(name) ?? [];
			decls.push({ where, req });
			byName.set(name, decls);
		}
	}

	for (const [name, decls] of [...byName.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		if (decls.length < 2) continue;

		const first = decls[0]!.req;
		const conflicting = new Set<string>();
		for (const { req } of decls.slice(1)) {
			if (req.type !== first.type) conflicting.add("type");
			if ((req.version ?? "") !== (first.version ?? ""))
				conflicting.add("version");
			if (configKey(req.config) !== configKey(first.config))
				conflicting.add("config");
		}

		if (conflicting.size > 0) {
			const fields = [...conflicting].sort().join(", ");
			const places = [...new Set(decls.map((d) => d.where))].sort().join(", ");
			warnings.push(
				`resource "${name}" is declared with divergent ${fields} across ${places}; ` +
					"entries sharing a name should share their definition (see D-24)",
			);
		}
	}

	checkResourceProperties(launch, warnings);

	return warnings;
}
