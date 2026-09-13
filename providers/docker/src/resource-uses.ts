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
 * `COVERAGE` is the one table every path reads — what a provisioned entry
 * registers, what a supplied map must carry, and which supplied keys the
 * redactor treats as structural — so the provisioned and supplied paths
 * cannot disagree about a use. For every type the standard vocabulary
 * registers (`RESOURCE_USE_VOCABULARY`), the table registers exactly the
 * registry's keys; `__tests__/resource-uses.test.ts` pins that. `mariadb`
 * has no entry in the registry — it is a provider-defined type under L-4 —
 * and is covered here the way `mysql` is.
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

/** Property map a factory produced, or the orchestrator supplied. */
export type Properties = Readonly<Record<string, string>>;

/** What one covered use registers, given the instance map and the allocated redis index. */
type Cover = (base: Properties, dbIndex: number) => Record<string, string>;

const SQL_SERVER_USES: Readonly<Record<string, Cover>> = {
	database: (base) => ({
		"database.url": base.url ?? "",
		"database.name": base.name ?? "",
	}),
	server: () => ({}),
};

const COVERAGE: Readonly<Record<string, Readonly<Record<string, Cover>>>> = {
	redis: {
		db: (base, dbIndex) => ({
			"db.url": `${base.url}/${dbIndex}`,
			"db.index": String(dbIndex),
		}),
		pubsub: () => ({}),
		server: () => ({}),
	},
	postgres: SQL_SERVER_USES,
	mysql: SQL_SERVER_USES,
	mariadb: SQL_SERVER_USES,
};

/** The resource types this provider covers uses on. */
export const COVERED_TYPES: readonly string[] = Object.keys(COVERAGE);

/** The use tokens this provider covers on `type`; empty for a type it covers none on. */
export function coveredUses(type: string): readonly string[] {
	const uses = Object.hasOwn(COVERAGE, type) ? COVERAGE[type] : undefined;
	return uses ? Object.keys(uses) : [];
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
	const uses = Object.hasOwn(COVERAGE, type) ? COVERAGE[type] : undefined;
	const cover = uses && Object.hasOwn(uses, use) ? uses[use] : undefined;
	return cover ? cover(base, dbIndex) : undefined;
}

/**
 * The `<use>.<property>` keys this provider registers for `uses` on `type`,
 * in declaration order. A use it does not cover registers nothing here — it
 * is unknown, not empty.
 */
export function usePropertyKeys(
	type: string,
	uses: readonly string[],
): string[] {
	const keys: string[] = [];
	for (const use of uses) {
		for (const key of Object.keys(coverUse(type, use, {}, 0) ?? {}))
			keys.push(key);
	}
	return keys;
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
 * The declared uses a supplied property map does not cover — a token this
 * provider does not recognise, or a registered `<use>.<property>` key the
 * map lacks (D-56 rule 1: the provider refuses on what it can observe). Each
 * entry names the use and, where it applies, the missing key.
 */
export function uncoveredSuppliedUses(
	type: string,
	uses: readonly string[],
	supplied: Properties,
): string[] {
	const uncovered: string[] = [];
	for (const use of uses) {
		if (coverUse(type, use, {}, 0) === undefined) {
			uncovered.push(`${use} (not a use this provider recognises)`);
			continue;
		}
		const missing = usePropertyKeys(type, [use]).filter(
			(key) => !Object.hasOwn(supplied, key),
		);
		if (missing.length > 0) {
			uncovered.push(
				`${use} (the supplied resource lacks ${missing.join(", ")})`,
			);
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
