/**
 * The `required:` environment-variable arrival test (D-52, PROVIDERS.md §10 rule 8).
 *
 * One implementation, shared by every provider and by the catalog harness. The
 * heuristic this replaces existed in two independent copies, which is why one
 * fix had to be made twice; a single predicate is what stops a third copy.
 */

import type { NormalizedComponent } from "./types.js";

/** A `required:` variable the Launchfile itself yields no value for. */
export interface UnsuppliedRequiredEnv {
	/** The environment variable name. */
	key: string;
	/** `env.<KEY>.sensitive === true` (D-18) — a fabricated value here is a constant credential. */
	sensitive: boolean;
}

/**
 * List the component's `required:` variables that no value source in the file
 * supplies.
 *
 * The test is **arrival, not declaration**: a `set_env:` binding counts only
 * when it actually injects, so the caller passes `suppliedKeys` — the keys that
 * really arrived after its own resolution ran. A binding on a `supports:`
 * resource that was never provisioned, or on a resource type the provider
 * cannot map, therefore leaves its variable unsupplied even though a binding
 * for it exists.
 *
 * `generator:` and `default:` (expression defaults included) are the file
 * answering for itself, so they are supplied — including a `default:` whose
 * expression resolves to `""`. D-52's *Scope* paragraph leaves that
 * empty-arrival route to L-4; widening this predicate to cover it would change
 * what `required` means beyond what was ratified.
 */
export function unsuppliedRequiredEnv(
	component: NormalizedComponent,
	suppliedKeys: Iterable<string>,
): UnsuppliedRequiredEnv[] {
	const supplied = suppliedKeys instanceof Set ? suppliedKeys : new Set(suppliedKeys);
	const unsupplied: UnsuppliedRequiredEnv[] = [];

	for (const [key, envVar] of Object.entries(component.env ?? {})) {
		if (!envVar.required) continue;
		if (envVar.generator) continue;
		if (envVar.default !== undefined) continue;
		if (supplied.has(key)) continue;
		unsupplied.push({ key, sensitive: envVar.sensitive === true });
	}

	return unsupplied;
}
