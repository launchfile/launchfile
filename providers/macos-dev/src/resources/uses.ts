/**
 * Coverage of a `requires`/`supports` entry's declared `uses` (SPEC.md
 * § Resource uses) by this provider's provisioners.
 *
 * A declared use is covered when the provisioner can hand over what the use
 * asks for and register its properties under `<use>.<property>` — the dotted
 * keys `$<resource>.<use>.<property>` resolves from. A named occurrence of a
 * repeatable use (`- db: cache`) registers under `<use>.<name>.<property>`
 * and is addressed as `$<resource>.<use>.<name>.<property>`. A use this
 * provider cannot cover, a token it does not recognise, or a name on a use
 * that does not repeat, refuses the component (PROVIDERS.md §10 item 5,
 * D-64): no provider can claim to cover a use it does not know. This
 * provider has no supplied-resource channel, so provision-and-cover or
 * refuse are its only outcomes.
 *
 * Every function here takes **use keys** — `db` for a bare use, `db.cache`
 * for a named one — the spelling `useKeys` from `@launchfile/sdk` produces
 * and the resolver context lists.
 *
 * What each provisioner gives:
 *
 * - **redis** — the machine's Homebrew Redis, shared by every app on it. `db`
 *   is one numbered database on that server, allocated per use key within
 *   the app by `allocateDbIndexes` from `@launchfile/sdk`, the one allocation
 *   every provider applies; `pubsub` and `server` are covered by
 *   the server itself and register nothing beyond the instance vocabulary.
 *   The server is shared across apps on this machine exactly as it is for an
 *   entry with no `uses` — a machine-wide index allocation is not attempted
 *   here.
 * - **postgres / mysql / mariadb** — a per-app database on the local server.
 *   A bare `database` is that database; each named `database` is one more
 *   database on the server, `<instance>_<name>` (`namedDatabase` from
 *   `@launchfile/sdk`), created by the provisioner's own create-database
 *   path; `server` is the local instance.
 *
 * The three shared rules — `allocateDbIndexes`, `namedDatabase`,
 * `withDatabasePath` and the `DbIndexes` type — are re-exported here so the
 * provisioners and state code keep one import path for everything about uses.
 */

import {
	type DbIndexes,
	formatUseKey,
	namedDatabase,
	parseUseKey,
	withDatabasePath,
} from "@launchfile/sdk";
import type { ResourceProperties } from "./types.js";

export {
	allocateDbIndexes,
	type DbIndexes,
	namedDatabase,
	withDatabasePath,
} from "@launchfile/sdk";

/** What one cover sees: the instance map, the occurrence's name, and its allocated redis index. */
interface CoverInput {
	readonly base: ResourceProperties;
	readonly name?: string;
	readonly dbIndex: number;
}

type Cover = (input: CoverInput) => Record<string, string | number>;

interface UseCoverage {
	readonly cover: Cover;
	/** Whether the use may be named more than once on one entry (`- db: cache`). */
	readonly repeatable: boolean;
}

const SQL_SERVER_USES: Readonly<Record<string, UseCoverage>> = {
	database: {
		repeatable: true,
		cover: ({ base, name }) => {
			if (name === undefined) {
				return { "database.url": base.url, "database.name": base.name ?? "" };
			}
			const database = namedDatabase(base.name ?? "", name);
			return {
				[`database.${name}.url`]: withDatabasePath(base.url, database),
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
				// The instance url may already select database 0; the use's
				// url selects the allocated index instead.
				const instance = base.url.replace(/\/\d+$/, "");
				const prefix = name === undefined ? "db" : `db.${name}`;
				return { [`${prefix}.url`]: `${instance}/${dbIndex}`, [`${prefix}.index`]: dbIndex };
			},
		},
		pubsub: { repeatable: false, cover: () => ({}) },
		server: { repeatable: false, cover: () => ({}) },
	},
	postgres: SQL_SERVER_USES,
	mysql: SQL_SERVER_USES,
	mariadb: SQL_SERVER_USES,
};

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
	base: ResourceProperties,
	dbIndexes: DbIndexes,
): Record<string, string | number> | undefined {
	const coverage = coverageOf(type, key);
	if (!coverage) return undefined;
	const { name } = parseUseKey(key);
	const dbIndex = Object.hasOwn(dbIndexes, key) ? dbIndexes[key]! : 0;
	return coverage.cover({ base, name, dbIndex });
}

/**
 * The declared use keys this provider cannot cover for `type`, each spelled
 * as the file spells it (`db: cache`) — the refusal's content. A name on a
 * use that does not repeat says so, since the token itself is one this
 * provider knows.
 */
export function uncoveredUses(type: string, keys: readonly string[]): string[] {
	const uncovered: string[] = [];
	for (const key of keys) {
		if (coverageOf(type, key) !== undefined) continue;
		const { use, name } = parseUseKey(key);
		const known = Object.hasOwn(COVERAGE, type) && Object.hasOwn(COVERAGE[type]!, use);
		uncovered.push(
			name !== undefined && known
				? `${formatUseKey(key)} (${use} on ${type} is not repeatable and takes no name)`
				: formatUseKey(key),
		);
	}
	return uncovered;
}

/**
 * The declared use keys this provider covers for `type`, in order. Used to
 * register a resource from the pooled uses of every same-name entry: a
 * pooled key this provider does not cover belongs to an unfulfilled
 * `supports` entry (a `requires` one refused its component already) and
 * registers nothing.
 */
export function coveredUses(type: string, keys: readonly string[]): string[] {
	return keys.filter((key) => coverageOf(type, key) !== undefined);
}

/**
 * The entry's property map with every declared use's properties registered
 * under `<use>.<property>` / `<use>.<name>.<property>`. Callers refuse before
 * reaching here, so an uncovered use is a caller bug and throws.
 */
export function withCoveredUses(
	type: string,
	keys: readonly string[] | undefined,
	base: ResourceProperties,
	dbIndexes: DbIndexes,
): ResourceProperties {
	const properties: ResourceProperties = { ...base };
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
 * the extra databases a SQL provisioner creates beside the app's. Empty for
 * any other token, named or not.
 */
export function namedDatabases(keys: readonly string[]): string[] {
	const names = new Set<string>();
	for (const key of keys) {
		const { use, name } = parseUseKey(key);
		if (use === "database" && name !== undefined) names.add(name);
	}
	return [...names].sort();
}
