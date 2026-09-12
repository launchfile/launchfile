/**
 * Coverage of a `requires`/`supports` entry's declared `uses` (SPEC.md
 * § Resource uses) by this provider's backing services.
 *
 * A declared use is covered when the provider can hand over what the use
 * asks for and register its properties under `<use>.<property>` in the
 * entry's property map — the dotted keys `$<resource>.<use>.<property>`
 * resolves from. A use this provider cannot cover, or a token it does not
 * recognise, refuses the component (PROVIDERS.md §10 item 5, D-64): no
 * provider can claim to cover a use it does not know.
 *
 * What each backing service gives:
 *
 * - **redis** — one instance per app, shared by every redis entry. `db` is one
 *   numbered database on it, allocated per entry (index 0 for the first);
 *   `pubsub` and `server` are covered by the instance itself, which nothing
 *   outside this app shares, and register nothing beyond the instance
 *   vocabulary.
 * - **postgres / mysql / mariadb** — one server per app with one database
 *   named after the app. `database` is that database; `server` the instance.
 */

import { RESOURCE_USE_VOCABULARY } from "@launchfile/sdk";

/** Property map a factory produced, or the orchestrator supplied. */
export type Properties = Readonly<Record<string, string>>;

/**
 * The `<use>.<property>` keys the standard vocabulary registers for `uses`
 * on `type`, in declaration order. A token outside the vocabulary registers
 * nothing here — it is unknown, not empty.
 */
export function usePropertyKeys(type: string, uses: readonly string[]): string[] {
	const vocabulary = Object.hasOwn(RESOURCE_USE_VOCABULARY, type)
		? RESOURCE_USE_VOCABULARY[type]
		: undefined;
	if (!vocabulary) return [];
	const keys: string[] = [];
	for (const use of uses) {
		const registered = Object.hasOwn(vocabulary, use) ? vocabulary[use] : undefined;
		for (const prop of registered ?? []) keys.push(`${use}.${prop}`);
	}
	return keys;
}

/**
 * The properties this provider registers for one declared use of a resource
 * it provisions, or `undefined` when it cannot cover the use. `dbIndex` is
 * the numbered database allocated to the entry when the use is redis `db`.
 */
export function coverUse(
	type: string,
	use: string,
	base: Properties,
	dbIndex: number,
): Record<string, string> | undefined {
	switch (type) {
		case "redis":
			switch (use) {
				case "db":
					return {
						"db.url": `${base.url}/${dbIndex}`,
						"db.index": String(dbIndex),
					};
				case "pubsub":
				case "server":
					return {};
				default:
					return undefined;
			}
		case "postgres":
		case "mysql":
		case "mariadb":
			switch (use) {
				case "database":
					return {
						"database.url": base.url ?? "",
						"database.name": base.name ?? "",
					};
				case "server":
					return {};
				default:
					return undefined;
			}
		default:
			return undefined;
	}
}

/**
 * The declared uses of a provisioned entry this provider cannot cover — the
 * refusal's content. Empty when every use is covered.
 */
export function uncoveredProvisionedUses(
	type: string,
	uses: readonly string[],
): string[] {
	return uses.filter((use) => coverUse(type, use, {}, 0) === undefined);
}

/**
 * The declared uses a supplied property map does not cover — a token the
 * vocabulary does not know, or a registered `<use>.<property>` key the map
 * lacks (D-56 rule 1: the provider refuses on what it can observe). Each
 * entry names the use and, where it applies, the missing key.
 */
export function uncoveredSuppliedUses(
	type: string,
	uses: readonly string[],
	supplied: Properties,
): string[] {
	const vocabulary = Object.hasOwn(RESOURCE_USE_VOCABULARY, type)
		? RESOURCE_USE_VOCABULARY[type]
		: undefined;
	const uncovered: string[] = [];
	for (const use of uses) {
		const registered =
			vocabulary && Object.hasOwn(vocabulary, use) ? vocabulary[use] : undefined;
		if (!registered) {
			uncovered.push(`${use} (not a use this provider recognises)`);
			continue;
		}
		const missing = registered
			.map((prop) => `${use}.${prop}`)
			.filter((key) => !Object.hasOwn(supplied, key));
		if (missing.length > 0) {
			uncovered.push(`${use} (the supplied resource lacks ${missing.join(", ")})`);
		}
	}
	return uncovered;
}

/**
 * The entry's property map with every declared use's properties registered
 * under `<use>.<property>`. Callers refuse before reaching here, so an
 * uncovered use is a caller bug and throws.
 */
export function withCoveredUses(
	type: string,
	uses: readonly string[] | undefined,
	base: Properties,
	dbIndex: number,
): Record<string, string> {
	const properties: Record<string, string> = { ...base };
	for (const use of uses ?? []) {
		const covered = coverUse(type, use, base, dbIndex);
		if (covered === undefined) {
			throw new Error(
				`withCoveredUses: use "${use}" on ${type} is not covered — the caller must refuse first`,
			);
		}
		Object.assign(properties, covered);
	}
	return properties;
}
