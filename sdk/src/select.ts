import type { NormalizedLaunch } from "./types.js";

/** Outcome of resolving a component selector against a launch. */
export interface SelectionResult {
	/** Requested component names that exist — the set the provider acts on. */
	selected: string[];
	/** Requested names that match only a resource (`requires`/`supports`), not a component. */
	resources: string[];
	/** Requested names that match neither a component nor a resource. */
	unknown: string[];
}

/**
 * Resolve a component selector against a normalized launch.
 *
 * Per the execution-mode taxonomy RFC (#77), selection is a verb-level concern:
 *  - selecting a component brings along its `requires` (those are nested inside
 *    the component, so a provider provisions them automatically); and
 *  - `depends_on` is satisfy-not-expand — selection does NOT pull dependency
 *    targets in; the provider verifies they are already running.
 *
 * Resources (postgres, redis, …) are NOT first-class units in the normalized
 * model — they live inside a component's `requires`/`supports`. They are
 * therefore not independently selectable. Requested names that match only a
 * resource are returned separately so the caller can emit a useful error
 * rather than silently dropping them.
 *
 * An empty `requested` selects everything (the all-components default).
 */
export function selectComponents(
	launch: NormalizedLaunch,
	requested: string[],
): SelectionResult {
	const componentNames = new Set(Object.keys(launch.components));
	const resourceNames = new Set<string>();
	for (const comp of Object.values(launch.components)) {
		for (const req of comp.requires ?? []) resourceNames.add(req.name ?? req.type);
		for (const sup of comp.supports ?? []) resourceNames.add(sup.name ?? sup.type);
	}

	if (requested.length === 0) {
		return { selected: Object.keys(launch.components), resources: [], unknown: [] };
	}

	const selected: string[] = [];
	const resources: string[] = [];
	const unknown: string[] = [];
	for (const name of requested) {
		if (componentNames.has(name)) selected.push(name);
		else if (resourceNames.has(name)) resources.push(name);
		else unknown.push(name);
	}
	return { selected, resources, unknown };
}
