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
 */

import type { UseDeclaration } from "./types.js";

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

/** The use key of one item: `db` for a bare token, `db.cache` for `{ db: cache }`. */
export function useKey(item: UseDeclaration | DeclaredUse): string {
	const decoded =
		typeof item === "string" || !("use" in item) ? declaredUse(item) : item;
	return decoded.name === undefined
		? decoded.use
		: `${decoded.use}.${decoded.name}`;
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
