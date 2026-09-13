/**
 * Coverage of a `requires`/`supports` entry's declared `uses` (SPEC.md
 * § Resource uses) by this provider's provisioners.
 *
 * A declared use is covered when the provisioner can hand over what the use
 * asks for and register its properties under `<use>.<property>` — the dotted
 * keys `$<resource>.<use>.<property>` resolves from. A use this provider
 * cannot cover, or a token it does not recognise, refuses the component
 * (PROVIDERS.md §10 item 5, D-64): no provider can claim to cover a use it
 * does not know. This provider has no supplied-resource channel, so
 * provision-and-cover or refuse are its only outcomes.
 *
 * What each provisioner gives:
 *
 * - **redis** — the machine's Homebrew Redis, shared by every app on it. `db`
 *   is one numbered database on that server, allocated per entry within the
 *   app (index 0 for the first); `pubsub` and `server` are covered by the
 *   server itself and register nothing beyond the instance vocabulary. The
 *   server is shared across apps on this machine exactly as it is today for
 *   an entry with no `uses` — a machine-wide index allocation is not
 *   attempted here.
 * - **postgres / mysql / mariadb** — a per-app database on the local server.
 *   `database` is that database; `server` the local instance.
 */

import type { ResourceProperties } from "./types.js";

/**
 * The properties this provider registers for one declared use of a resource
 * it provisions, or `undefined` when it cannot cover the use. `dbIndex` is
 * the numbered database allocated to the entry when the use is redis `db`.
 */
export function coverUse(
	type: string,
	use: string,
	base: ResourceProperties,
	dbIndex: number,
): Record<string, string | number> | undefined {
	switch (type) {
		case "redis":
			switch (use) {
				case "db": {
					// The instance url may already select database 0; the use's
					// url selects the allocated index instead.
					const instance = base.url.replace(/\/\d+$/, "");
					return { "db.url": `${instance}/${dbIndex}`, "db.index": dbIndex };
				}
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
						"database.url": base.url,
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

/** The declared uses this provider cannot cover for `type` — the refusal's content. */
export function uncoveredUses(type: string, uses: readonly string[]): string[] {
	return uses.filter((use) => coverUse(type, use, { url: "" }, 0) === undefined);
}

/**
 * The declared uses this provider covers for `type`, in order. Used to
 * register a resource from the pooled uses of every same-name entry: a
 * pooled token this provider does not cover belongs to an unfulfilled
 * `supports` entry (a `requires` one refused its component already) and
 * registers nothing.
 */
export function coveredUses(type: string, uses: readonly string[]): string[] {
	return uses.filter(
		(use) => coverUse(type, use, { url: "" }, 0) !== undefined,
	);
}

/**
 * The entry's property map with every declared use's properties registered
 * under `<use>.<property>`. Callers refuse before reaching here, so an
 * uncovered use is a caller bug and throws.
 */
export function withCoveredUses(
	type: string,
	uses: readonly string[] | undefined,
	base: ResourceProperties,
	dbIndex: number,
): ResourceProperties {
	const properties: ResourceProperties = { ...base };
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
