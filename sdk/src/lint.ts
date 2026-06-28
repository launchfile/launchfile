/**
 * Non-fatal lint checks over a normalized Launch.
 *
 * These complement the hard schema validation in {@link readLaunch}: a file can
 * be schema-valid yet still contain footguns worth surfacing. Like the
 * providers' warning channel, a lint result is a flat `string[]` of
 * human-readable messages — empty means clean. Lint never throws and never
 * rejects a file; it only advises.
 */

import type { NormalizedLaunch, NormalizedRequirement } from "./types.js";

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
 * Lint a normalized Launch, returning non-fatal warning strings (empty = clean).
 *
 * Currently checks (Q1): when two `requires`/`supports` entries across all
 * components (and any single-component top-level fields, which normalize into
 * the "default" component) resolve to the SAME resource name (D-24) but declare
 * DIVERGENT `type`, `version`, or `config`, a single warning per conflicting
 * resource names the field(s) that diverge. Same name + identical definition is
 * normal resource sharing and is not warned about.
 */
export function lintLaunch(launch: NormalizedLaunch): string[] {
	const warnings: string[] = [];

	// Collect every requires/supports declaration grouped by resolved name.
	const byName = new Map<string, ResourceDecl[]>();
	for (const [componentName, component] of Object.entries(launch.components)) {
		const where = componentName === "default" ? "(top-level)" : componentName;
		for (const req of [
			...(component.requires ?? []),
			...(component.supports ?? []),
		]) {
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

	return warnings;
}
