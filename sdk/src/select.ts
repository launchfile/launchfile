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
 * Classify a component selector against a normalized launch.
 *
 * This is the name-resolution primitive: it sorts the requested names into the
 * components that exist (`selected`), the names that match only a backing
 * resource (`resources`), and the names that match nothing (`unknown`). It does
 * NOT expand the dependency closure — that is {@link selectionClosure}'s job
 * (D-41). `selected` is exactly the requested components, in request order.
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
		for (const req of comp.requires ?? [])
			resourceNames.add(req.name ?? req.type);
		for (const sup of comp.supports ?? [])
			resourceNames.add(sup.name ?? sup.type);
	}

	if (requested.length === 0) {
		return {
			selected: Object.keys(launch.components),
			resources: [],
			unknown: [],
		};
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

/** {@link selectComponents} extended with the resolved D-41 start-set. */
export interface SelectionClosureResult extends SelectionResult {
	/**
	 * Component names a provider must start: the resolved `selected` set plus its
	 * transitive downward `depends_on` closure (D-41), sorted for determinism.
	 * Empty when the selection cannot be satisfied (i.e. `unknown` or `resources`
	 * is non-empty) — the caller errors on those before acting on `start`.
	 */
	start: string[];
}

/**
 * Resolve the D-41 start-set for a component selector: the requested components
 * (or all components when `requested` is empty) **plus their transitive downward
 * `depends_on` closure**. Each closure member's `requires` backing services come
 * along for free — they are nested inside the component, so narrowing a launch /
 * starting a service to the closure pulls them in at the provider boundary; this
 * helper deals only in component names.
 *
 * Downward only: reverse-dependencies (components that depend *on* a selected
 * one) and unrelated components are excluded. `depends_on` is honored as a hard
 * prerequisite (D-16) — a selected component cannot start without it.
 *
 * This is the single source of truth every provider computes its start-set from,
 * so the same Launchfile yields the same running topology everywhere (P-5).
 *
 * Pure (no input mutation) and cycle-safe: a `visited` set bounds the traversal,
 * so a `depends_on` cycle terminates instead of looping forever. Name resolution
 * is delegated to {@link selectComponents}, so unknown / resource-only names are
 * rejected identically; when the selection is invalid, `start` is empty.
 */
export function selectionClosure(
	launch: NormalizedLaunch,
	requested: string[],
): SelectionClosureResult {
	const base = selectComponents(launch, requested);
	if (base.unknown.length > 0 || base.resources.length > 0) {
		return { ...base, start: [] };
	}

	const known = new Set(Object.keys(launch.components));
	const visited = new Set<string>();
	const stack = [...base.selected];
	while (stack.length > 0) {
		const name = stack.pop();
		if (name === undefined || visited.has(name)) continue;
		visited.add(name);
		for (const dep of launch.components[name]?.depends_on ?? []) {
			// Guard against a dangling depends_on target and re-visiting a node: the
			// visited set is what makes a depends_on cycle terminate.
			if (known.has(dep.component) && !visited.has(dep.component)) {
				stack.push(dep.component);
			}
		}
	}

	return { ...base, start: [...visited].sort() };
}
