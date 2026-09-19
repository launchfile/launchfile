/**
 * Coverage of a `requires`/`supports` entry's declared `uses` (SPEC.md
 * § Resource uses) by this provider's backing services.
 *
 * A declared use is covered when the provider can hand over what the use
 * asks for and register its properties under `<use>.<property>` in the
 * entry's property map — the dotted keys `$<resource>.<use>.<property>`
 * resolves from. A named occurrence of a repeatable use (`- db: cache`)
 * registers under `<use>.<name>.<property>` and is addressed as
 * `$<resource>.<use>.<name>.<property>`. A use this provider cannot cover, a
 * token it does not recognise, or a name on a use that does not repeat,
 * refuses the component (PROVIDERS.md §10 item 5, D-64): no provider can
 * claim to cover a use it does not know.
 *
 * Every function here takes **use keys** — `db` for a bare use, `db.cache`
 * for a named one — the spelling `useKeys` from `@launchfile/sdk` produces
 * and the resolver context lists.
 *
 * `COVERAGE` is the one table every path reads — what a provisioned entry
 * registers, what a supplied map must carry, which supplied keys the
 * redactor treats as structural, and which uses may be named — so the
 * provisioned and supplied paths cannot disagree about a use. For every type
 * the standard vocabulary registers (`RESOURCE_USE_VOCABULARY`), the table
 * registers exactly the registry's keys and repeats exactly the registry's
 * repeatable uses; `__tests__/resource-uses.test.ts` pins that. `mariadb` has
 * no entry in the registry — it is a provider-defined type under L-4 — and is
 * covered here the way `mysql` is.
 *
 * What each backing service gives:
 *
 * - **redis** — one instance per app, shared by every redis entry. `db` is one
 *   numbered database on it, allocated per use key by {@link allocateDbIndexes};
 *   `pubsub` and `server` are covered by the instance itself, which nothing
 *   outside this app shares, and register nothing beyond the instance
 *   vocabulary.
 * - **postgres / mysql / mariadb** — one server per app with one database
 *   named after the app. A bare `database` is that database; each named
 *   `database` is one more database on the server, `<instance>_<name>`
 *   ({@link namedDatabase}), created by the init script the generator mounts;
 *   `server` is the instance.
 */

import {
	formatUseKey,
	type NormalizedLaunch,
	parseUseKey,
	useKeys,
} from "@launchfile/sdk";

/** Property map a factory produced, or the orchestrator supplied. */
export type Properties = Readonly<Record<string, string>>;

/**
 * The redis database index allocated to each `db` use key of one resource —
 * `db` for the bare use, `db.<name>` for a named one. Produced per resource
 * by {@link allocateDbIndexes}.
 */
export type DbIndexes = Readonly<Record<string, number>>;

/** What one cover sees: the instance map, the occurrence's name, and its allocated redis index. */
interface CoverInput {
	readonly base: Properties;
	readonly name?: string;
	readonly dbIndex: number;
}

/** What one covered use registers. */
type Cover = (input: CoverInput) => Record<string, string>;

interface UseCoverage {
	readonly cover: Cover;
	/** Whether the use may be named more than once on one entry (`- db: cache`). */
	readonly repeatable: boolean;
}

/**
 * The database a named `database` use gets on the provisioned server:
 * `<instance database>_<name>`, hyphens as underscores so the name is one SQL
 * identifier on every engine. The same rule on both reference providers.
 */
export function namedDatabase(instance: string, name: string): string {
	return `${instance}_${name.replace(/-/g, "_")}`;
}

/**
 * `url` with its path replaced by `/<database>`, the query and fragment kept:
 * the instance URL selects the instance database, a named use's URL selects
 * its own.
 */
export function withDatabasePath(url: string, database: string): string {
	const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(?:\/[^?#]*)?(.*)$/i.exec(url);
	if (!match) return url;
	return `${match[1]}/${database}${match[2]}`;
}

const SQL_SERVER_USES: Readonly<Record<string, UseCoverage>> = {
	database: {
		repeatable: true,
		cover: ({ base, name }) => {
			if (name === undefined) {
				return {
					"database.url": base.url ?? "",
					"database.name": base.name ?? "",
				};
			}
			const database = namedDatabase(base.name ?? "", name);
			return {
				[`database.${name}.url`]: withDatabasePath(base.url ?? "", database),
				[`database.${name}.name`]: database,
			};
		},
	},
	server: { repeatable: false, cover: () => ({}) },
};

const COVERAGE: Readonly<Record<string, Readonly<Record<string, UseCoverage>>>> = {
	redis: {
		db: {
			repeatable: true,
			cover: ({ base, name, dbIndex }) => {
				const prefix = name === undefined ? "db" : `db.${name}`;
				return {
					[`${prefix}.url`]: `${base.url}/${dbIndex}`,
					[`${prefix}.index`]: String(dbIndex),
				};
			},
		},
		pubsub: { repeatable: false, cover: () => ({}) },
		server: { repeatable: false, cover: () => ({}) },
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

/** The use tokens this provider may cover more than once, named, on `type`. */
export function repeatableUses(type: string): readonly string[] {
	const uses = Object.hasOwn(COVERAGE, type) ? COVERAGE[type] : undefined;
	return uses
		? Object.entries(uses)
				.filter(([, coverage]) => coverage.repeatable)
				.map(([use]) => use)
		: [];
}

function coverageOf(type: string, key: string): UseCoverage | undefined {
	const uses = Object.hasOwn(COVERAGE, type) ? COVERAGE[type] : undefined;
	const { use, name } = parseUseKey(key);
	const coverage = uses && Object.hasOwn(uses, use) ? uses[use] : undefined;
	if (!coverage) return undefined;
	return name !== undefined && !coverage.repeatable ? undefined : coverage;
}

/**
 * The properties this provider registers for one declared use key of a
 * resource it provisions, or `undefined` when it cannot cover it — a token it
 * does not know, or a name on a use that does not repeat. `dbIndexes` carries
 * the numbered database allocated to each `db` key when the type is redis.
 */
export function coverUse(
	type: string,
	key: string,
	base: Properties,
	dbIndexes: DbIndexes,
): Record<string, string> | undefined {
	const coverage = coverageOf(type, key);
	if (!coverage) return undefined;
	const { name } = parseUseKey(key);
	const dbIndex = Object.hasOwn(dbIndexes, key) ? dbIndexes[key]! : 0;
	return coverage.cover({ base, name, dbIndex });
}

/**
 * The `<use>.<property>` (or `<use>.<name>.<property>`) keys this provider
 * registers for the use keys on `type`, in declaration order. A use it does
 * not cover registers nothing here — it is unknown, not empty.
 */
export function usePropertyKeys(
	type: string,
	keys: readonly string[],
): string[] {
	const result: string[] = [];
	for (const key of keys) {
		for (const property of Object.keys(coverUse(type, key, {}, {}) ?? {}))
			result.push(property);
	}
	return result;
}

/** Why one use key is uncovered on `type` — the refusal's wording for it. */
function uncoveredReason(type: string, key: string, provisioned: boolean): string {
	const { use, name } = parseUseKey(key);
	if (name !== undefined && coveredUses(type).includes(use)) {
		return `${formatUseKey(key)} (${use} on ${type} is not repeatable and takes no name)`;
	}
	return provisioned
		? `${formatUseKey(key)} (not a use this provider covers for ${type})`
		: `${formatUseKey(key)} (not a use this provider recognises)`;
}

/**
 * The declared use keys of a provisioned entry this provider cannot cover,
 * each with the reason — the refusal's content. Empty when every use is
 * covered.
 */
export function uncoveredProvisionedUses(
	type: string,
	keys: readonly string[],
): string[] {
	return keys
		.filter((key) => coverageOf(type, key) === undefined)
		.map((key) => uncoveredReason(type, key, true));
}

/**
 * The declared use keys a supplied property map does not cover — a token this
 * provider does not recognise, a name on a use that does not repeat, or a
 * registered `<use>.<property>` key the map lacks (D-56 rule 1: the provider
 * refuses on what it can observe). Each entry names the use (and its name)
 * and, where it applies, the missing keys.
 */
export function uncoveredSuppliedUses(
	type: string,
	keys: readonly string[],
	supplied: Properties,
): string[] {
	const uncovered: string[] = [];
	for (const key of keys) {
		if (coverageOf(type, key) === undefined) {
			uncovered.push(uncoveredReason(type, key, false));
			continue;
		}
		const missing = usePropertyKeys(type, [key]).filter(
			(property) => !Object.hasOwn(supplied, property),
		);
		if (missing.length > 0) {
			uncovered.push(
				`${formatUseKey(key)} (the supplied resource lacks ${missing.join(", ")})`,
			);
		}
	}
	return uncovered;
}

/**
 * The entry's property map with every declared use's properties registered
 * under `<use>.<property>` / `<use>.<name>.<property>`. Callers refuse before
 * reaching here, so an uncovered use is a caller bug and throws.
 */
export function withCoveredUses(
	type: string,
	keys: readonly string[] | undefined,
	base: Properties,
	dbIndexes: DbIndexes,
): Record<string, string> {
	const properties: Record<string, string> = { ...base };
	for (const key of keys ?? []) {
		const covered = coverUse(type, key, base, dbIndexes);
		if (covered === undefined) {
			throw new Error(
				`withCoveredUses: use "${formatUseKey(key)}" on ${type} is not covered — the caller must refuse first`,
			);
		}
		Object.assign(properties, covered);
	}
	return properties;
}

/**
 * The names of the named `database` uses among `keys`, sorted and unique —
 * the extra databases a SQL server must be created with. Empty for any other
 * token, named or not.
 */
export function namedDatabases(keys: readonly string[]): string[] {
	const names = new Set<string>();
	for (const key of keys) {
		const { use, name } = parseUseKey(key);
		if (use === "database" && name !== undefined) names.add(name);
	}
	return [...names].sort();
}

/**
 * One numbered redis database per `db` use key, app-wide, keyed by resource
 * name — the same allocation on both reference providers (D-65 conformance),
 * so one file yields the same `db.*` values under each:
 *
 * - redis resources take blocks in the order their first `db`-declaring entry
 *   appears, walking components in file order and `requires` before
 *   `supports` — a `supports` entry's `db` takes its index whether or not the
 *   entry is fulfilled;
 * - within a block the bare `db` (if any same-name entry declares it) takes
 *   the first index and the named `db` uses follow in name order, so
 *   `- db: sessions` beside `- db: cache` is the later index whichever is
 *   written first.
 *
 * Index 0 is the first allocated. Same-name entries pool their keys (D-24).
 * A resource that declares no `db` use has no entry.
 */
export function allocateDbIndexes(
	launch: NormalizedLaunch,
): Record<string, DbIndexes> {
	const pooled = new Map<string, Set<string>>();
	for (const component of Object.values(launch.components)) {
		for (const entry of [
			...(component.requires ?? []),
			...(component.supports ?? []),
		]) {
			if (entry.host || entry.type !== "redis" || !entry.uses) continue;
			const dbKeys = useKeys(entry.uses).filter(
				(key) => parseUseKey(key).use === "db",
			);
			if (dbKeys.length === 0) continue;
			const key = entry.name ?? entry.type;
			const keys = pooled.get(key) ?? new Set<string>();
			for (const dbKey of dbKeys) keys.add(dbKey);
			pooled.set(key, keys);
		}
	}
	const allocation: Record<string, DbIndexes> = {};
	let next = 0;
	for (const [resource, keys] of pooled) {
		const indexes: Record<string, number> = {};
		if (keys.has("db")) indexes.db = next++;
		for (const key of [...keys].filter((k) => k !== "db").sort()) {
			indexes[key] = next++;
		}
		allocation[resource] = indexes;
	}
	return allocation;
}
