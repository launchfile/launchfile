/**
 * The two spellings of a `uses` item (SPEC.md § Resource uses) and the one
 * key every consumer works with.
 *
 * A bare token (`db`) declares an unnamed use. A single-key map
 * (`{ db: "cache" }`) declares one named occurrence of a repeatable use, so
 * the token may appear more than once on an entry. Providers register a
 * named use's properties under `<use>.<name>.<property>` and the resolver
 * addresses them as `$<resource>.<use>.<name>.<property>`; the **use key** —
 * `db` for the bare form, `db.cache` for the named form — is the prefix both
 * sides share, and the string a resolver context lists per resource.
 *
 * Tokens and names take the name grammar (`^[a-z][a-z0-9-]*$`), so a use key
 * has at most one dot and splits back without ambiguity.
 *
 * The values a covered use registers are the provider's, but two of them are
 * fixed by conformance (D-65): which numbered redis database each `db` use
 * key gets ({@link allocateDbIndexes}) and what a named `database` use's
 * database is called ({@link namedDatabase}, {@link withDatabasePath}). Every
 * provider computes them here so one file yields the same values under each.
 */

import type { NormalizedLaunch, UseDeclaration } from "./types.js";

/** One `uses` item, decoded: the token, and the name when the item is the map form. */
export interface DeclaredUse {
	readonly use: string;
	readonly name?: string;
}

/** Decode one `uses` item. A map with more than one key is a schema error and never reaches here; the first key is taken. */
export function declaredUse(item: UseDeclaration): DeclaredUse {
	if (typeof item === "string") return { use: item };
	const [entry] = Object.entries(item);
	return entry ? { use: entry[0], name: entry[1] } : { use: "" };
}

/** The use key of a decoded use: `db` when unnamed, `db.cache` when named. */
export function useKeyOf({ use, name }: DeclaredUse): string {
	return name === undefined ? use : `${use}.${name}`;
}

/**
 * The use key of one `uses` item as written: `db` for a bare token, `db.cache`
 * for `{ db: cache }`. The item is always the file's spelling — a map keyed
 * `use` is a provider-defined token named `use`, never a decoded value — so
 * `{ use: a }` keys as `use.a`. A decoded {@link DeclaredUse} takes
 * {@link useKeyOf}.
 */
export function useKey(item: UseDeclaration): string {
	return useKeyOf(declaredUse(item));
}

/** The use keys of a `uses` list, in declaration order; empty for an entry that declares none. */
export function useKeys(
	uses: readonly UseDeclaration[] | undefined,
): string[] {
	return (uses ?? []).map(useKey);
}

/** Split a use key back into token and name: `db.cache` → `{ use: "db", name: "cache" }`. */
export function parseUseKey(key: string): DeclaredUse {
	const dot = key.indexOf(".");
	return dot === -1
		? { use: key }
		: { use: key.slice(0, dot), name: key.slice(dot + 1) };
}

/** `db` for a bare key, `db: cache` for a named one — the spelling diagnostics use. */
export function formatUseKey(key: string): string {
	const { use, name } = parseUseKey(key);
	return name === undefined ? use : `${use}: ${name}`;
}

/**
 * The redis database index allocated to each `db` use key of one resource —
 * `db` for the bare use, `db.<name>` for a named one. Produced per resource
 * by {@link allocateDbIndexes}.
 */
export type DbIndexes = Readonly<Record<string, number>>;

/**
 * The database a named `database` use gets on the provisioned SQL server:
 * `<instance database>_<name>`, hyphens as underscores so the name is one SQL
 * identifier on every engine.
 */
export function namedDatabase(instance: string, name: string): string {
	return `${instance}_${name.replace(/-/g, "_")}`;
}

/**
 * `url` with its path replaced by `/<database>`, the query and fragment kept:
 * the instance URL selects the instance database, a named use's URL selects
 * its own. A string that is not a URL comes back unchanged.
 */
export function withDatabasePath(url: string, database: string): string {
	const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(?:\/[^?#]*)?(.*)$/i.exec(url);
	if (!match) return url;
	return `${match[1]}/${database}${match[2]}`;
}

/**
 * One numbered redis database per `db` use key, app-wide, keyed by resource
 * name — the allocation every provider applies (D-65 conformance), so one
 * file yields the same `db.*` values under each:
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
 * A resource that declares no `db` use has no entry, and a host-capability
 * entry is not a redis resource.
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
