/**
 * Declared `uses` on a `requires`/`supports` entry (SPEC.md § Resource uses):
 * this provider covers every declared use — registering each one's
 * `<use>.<property>` keys, and a named occurrence's `<use>.<name>.<property>`
 * keys — or refuses the component before anything is provisioned, installed,
 * wired or started (D-56 rule 1, D-64). It has no supplied-resource channel,
 * so cover-or-refuse are its only outcomes. The outcome (the component is
 * gone) is what is pinned, never only the message.
 */

import { isRepeatableUse, readLaunch, RESOURCE_USE_VOCABULARY, UnresolvedUseError } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import {
	buildResolverContext,
	declaredUses,
	registerResource,
	resolveComponentEnv,
} from "../env-writer.js";
import { applyResourceUseRefusals, refusedResourceUses } from "../provider.js";
import { clearRegisteredSecrets, REDACTED, redactSecrets } from "../redact.js";
import {
	allocateDbIndexes,
	coverUse,
	coveredUses,
	namedDatabase,
	namedDatabases,
	uncoveredUses,
	withCoveredUses,
	withDatabasePath,
} from "../resources/index.js";
import type { ResourceProperties } from "../resources/types.js";
import { recordedDbIndexes, withRecordedDbIndexes, type ResourceState } from "../state.js";

const mk = (body: string) => readLaunch(`version: launch/v1\nname: app\n${body}`);

const START = "commands:\n  start: run\n";

describe("refusedResourceUses", () => {
	it("refuses a component whose redis entry declares a use this provider does not recognise", () => {
		const launch = mk(`${START}requires:\n  - type: redis\n    uses: [nosuchuse]\n`);
		expect(refusedResourceUses(launch).get("default")).toEqual(["redis: nosuchuse"]);
	});

	it("names a named entry by its name", () => {
		const launch = mk(`${START}requires:\n  - type: redis\n    name: cache\n    uses: [db, nosuchuse]\n`);
		expect(refusedResourceUses(launch).get("default")).toEqual(["cache: nosuchuse"]);
	});

	it("covers db, pubsub and server on redis, and database and server on the sql types", () => {
		const launch = mk(
			`${START}requires:\n  - type: redis\n    uses: [db, pubsub, server]\n  - type: postgres\n    uses: [database, server]\n  - type: mysql\n    uses: [database]\n  - type: mariadb\n    uses: [server]\n`,
		);
		expect(refusedResourceUses(launch).size).toBe(0);
	});

	it("covers named db and database uses", () => {
		const launch = mk(
			`${START}requires:\n  - type: redis\n    uses: [{db: cache}, {db: sessions}, pubsub]\n  - type: postgres\n    uses: [{database: reports}, {database: audit-log}]\n  - type: mariadb\n    uses: [{database: events}]\n`,
		);
		expect(refusedResourceUses(launch).size).toBe(0);
	});

	it("refuses a name on a use that does not repeat, naming the token and the name (D-64)", () => {
		// mariadb has no registry entry, so the schema lets the name through;
		// this provider knows `server` does not repeat and refuses.
		const launch = mk(`${START}requires:\n  - type: mariadb\n    uses: [{server: main}]\n`);
		expect(refusedResourceUses(launch).get("default")).toEqual([
			"mariadb: server: main (server on mariadb is not repeatable and takes no name)",
		]);
	});

	it("refuses a named token it does not recognise, spelled as the file spells it", () => {
		const launch = mk(`${START}requires:\n  - type: redis\n    uses: [{streams: orders}]\n`);
		expect(refusedResourceUses(launch).get("default")).toEqual(["redis: streams: orders"]);
	});

	it("refuses a recognised token of another type — database is not a redis use", () => {
		const launch = mk(`${START}requires:\n  - type: redis\n    uses: [database]\n`);
		expect(refusedResourceUses(launch).get("default")).toEqual(["redis: database"]);
	});

	it("leaves a type with no provisioner to the type refusal (D-64)", () => {
		const launch = mk(`${START}requires:\n  - type: kafka\n    uses: [topics]\n`);
		expect(refusedResourceUses(launch).size).toBe(0);
	});

	it("does not grade a supports entry — optional resources are not preconditions (D-8)", () => {
		const launch = mk(`${START}supports:\n  - type: redis\n    uses: [nosuchuse]\n`);
		expect(refusedResourceUses(launch).size).toBe(0);
	});

	it("does not grade an entry that declares no uses", () => {
		const launch = mk(`${START}requires:\n  - type: redis\n`);
		expect(refusedResourceUses(launch).size).toBe(0);
	});
});

describe("applyResourceUseRefusals — the refusal is the removal", () => {
	it("removes the refused component from the run", () => {
		const launch = mk(`${START}requires:\n  - type: redis\n    uses: [nosuchuse]\n`);
		expect(applyResourceUseRefusals(launch)).toBe("none-left");
		expect(Object.keys(launch.components)).toEqual([]);
	});

	it("keeps the siblings whose uses this provider covers", () => {
		const launch = readLaunch(`version: launch/v1
name: app
components:
  web:
    commands: { start: run }
    requires:
      - type: redis
        uses: [db]
  worker:
    commands: { start: run }
    requires:
      - type: redis
        uses: [nosuchuse]
`);
		expect(applyResourceUseRefusals(launch)).toBe("ok");
		expect(Object.keys(launch.components)).toEqual(["web"]);
	});
});

describe("coverage", () => {
	const REDIS: ResourceProperties = { url: "redis://localhost:6379/0", host: "localhost", port: 6379 };

	it("registers db.url with the allocated index in place of the instance's selector", () => {
		expect(coverUse("redis", "db", REDIS, { db: 3 })).toEqual({
			"db.url": "redis://localhost:6379/3",
			"db.index": 3,
		});
	});

	it("registers a named db under its name, with the index allocated to that key", () => {
		expect(coverUse("redis", "db.cache", REDIS, { db: 0, "db.cache": 2 })).toEqual({
			"db.cache.url": "redis://localhost:6379/2",
			"db.cache.index": 2,
		});
	});

	it("registers database.url and database.name for postgres", () => {
		const base: ResourceProperties = {
			url: "postgresql://u:p@localhost:5432/launchfile_app",
			name: "launchfile_app",
		};
		expect(coverUse("postgres", "database", base, {})).toEqual({
			"database.url": base.url,
			"database.name": "launchfile_app",
		});
	});

	it("registers a named database as <instance>_<name> with the url's path swapped", () => {
		const base: ResourceProperties = {
			url: "postgresql://u:p@localhost:5432/launchfile_app",
			name: "launchfile_app",
		};
		expect(coverUse("postgres", "database.audit-log", base, {})).toEqual({
			"database.audit-log.url": "postgresql://u:p@localhost:5432/launchfile_app_audit_log",
			"database.audit-log.name": "launchfile_app_audit_log",
		});
		expect(namedDatabase("launchfile_app", "event-log")).toBe("launchfile_app_event_log");
		expect(withDatabasePath("mysql://u:p@localhost:3306/app", "app_x")).toBe("mysql://u:p@localhost:3306/app_x");
	});

	it("does not cover a name on a use that does not repeat", () => {
		expect(coverUse("redis", "pubsub.events", REDIS, {})).toBeUndefined();
		expect(coverUse("postgres", "server.main", { url: "" }, {})).toBeUndefined();
	});

	it("repeats exactly the uses the standard vocabulary marks repeatable", () => {
		for (const [type, uses] of Object.entries(RESOURCE_USE_VOCABULARY)) {
			for (const use of Object.keys(uses)) {
				const named = coverUse(type, `${use}.x`, { url: "", name: "n" }, {}) !== undefined;
				expect(named, `${type}.${use}`).toBe(isRepeatableUse(type, use));
			}
		}
	});

	it("lists the uncovered keys only, spelled as the file spells them", () => {
		expect(uncoveredUses("redis", ["db", "x", "pubsub", "y"])).toEqual(["x", "y"]);
		expect(uncoveredUses("redis", ["db.cache", "pubsub.events", "streams.orders"])).toEqual([
			"pubsub: events (pubsub on redis is not repeatable and takes no name)",
			"streams: orders",
		]);
	});

	it("lists the covered keys only, in order — the pooled set a resource registers from", () => {
		expect(coveredUses("redis", ["pubsub", "x", "db", "db.cache"])).toEqual(["pubsub", "db", "db.cache"]);
		expect(coveredUses("kafka", ["topics"])).toEqual([]);
	});

	it("covers mariadb's database and server the way it covers mysql's", () => {
		const base: ResourceProperties = { url: "mysql://u:p@localhost:3306/launchfile_app", name: "launchfile_app" };
		expect(coverUse("mariadb", "database", base, {})).toEqual(coverUse("mysql", "database", base, {}));
		expect(coverUse("mariadb", "database.a", base, {})).toEqual(coverUse("mysql", "database.a", base, {}));
		expect(uncoveredUses("mariadb", ["database", "server", "nosuchuse"])).toEqual(["nosuchuse"]);
	});

	it("names the named database uses, sorted and unique, and nothing else", () => {
		expect(namedDatabases(["database", "database.b", "db.a", "database.a", "database.b"])).toEqual(["a", "b"]);
		expect(namedDatabases(["db.cache", "server"])).toEqual([]);
	});

	it("registers no use key with the redactor; a credential inside db.url is scrubbed by pattern (D-56 rule 5)", () => {
		clearRegisteredSecrets();
		const map = withCoveredUses(
			"redis",
			["db"],
			{ url: "redis://app:pw-only-in-the-url@localhost:6379/0", host: "localhost", port: 6379 },
			{ db: 7 },
		);
		expect(map["db.index"]).toBe(7);
		expect(redactSecrets("db 7 on port 6379")).toBe("db 7 on port 6379");
		expect(redactSecrets(String(map["db.url"]))).toBe(`redis://app:${REDACTED}@localhost:6379/7`);
	});

	it("leaves a map with no uses untouched — files without uses are byte-identical (P-13)", () => {
		const base: ResourceProperties = { url: "redis://localhost:6379/0", host: "localhost", port: 6379, password: "" };
		expect(withCoveredUses("redis", undefined, base, {})).toEqual(base);
	});

	it("throws on an uncovered use — the caller must refuse first", () => {
		expect(() => withCoveredUses("redis", ["nosuchuse"], { url: "redis://localhost:6379" }, {})).toThrow(
			/must refuse first/,
		);
		expect(() => withCoveredUses("redis", ["pubsub.x"], { url: "redis://localhost:6379" }, {})).toThrow(
			/use "pubsub: x" on redis is not covered/,
		);
	});
});

describe("allocateDbIndexes — one rule, shared with @launchfile/docker", () => {
	it("gives the bare db the first index of a resource's block and the named dbs the rest in name order", () => {
		const launch = mk(`${START}requires:\n  - type: redis\n    uses: [{db: sessions}, {db: cache}, pubsub]\n`);
		expect(allocateDbIndexes(launch)).toEqual({ redis: { "db.cache": 0, "db.sessions": 1 } });
	});

	it("orders resources by their first db-declaring entry, components in file order, requires before supports", () => {
		const launch = readLaunch(`version: launch/v1
name: app
components:
  web:
    commands: { start: run }
    requires:
      - type: redis
        name: main
        uses: [pubsub]
      - type: redis
        name: queue
        uses: [{db: jobs}]
    supports:
      - type: redis
        name: optional
        uses: [db]
  worker:
    commands: { start: run }
    requires:
      - type: redis
        name: main
        uses: [{db: cache}]
  api:
    commands: { start: run }
    requires:
      - type: redis
        name: main
        uses: [db]
`);
		// `main` pools a bare db (api) and a named one (worker) under D-24;
		// its block starts where its first db-declaring entry (worker) is seen.
		expect(allocateDbIndexes(launch)).toEqual({
			queue: { "db.jobs": 0 },
			optional: { db: 1 },
			main: { db: 2, "db.cache": 3 },
		});
	});

	it("has no entry for a resource that declares no db use", () => {
		const launch = mk(`${START}requires:\n  - type: redis\n    uses: [pubsub]\n  - type: postgres\n    uses: [{database: a}]\n`);
		expect(allocateDbIndexes(launch)).toEqual({});
	});
});

describe("state records the allocation per resource: bare `dbIndex`, named `namedDbIndexes`", () => {
	const base: ResourceState = { type: "redis", name: "redis", port: 6379 };

	it("round-trips a mixed allocation and records nothing for an empty one", () => {
		const recorded = withRecordedDbIndexes(base, { db: 2, "db.cache": 3, "db.sessions": 4 });
		expect(recorded).toEqual({ ...base, dbIndex: 2, namedDbIndexes: { cache: 3, sessions: 4 } });
		expect(recordedDbIndexes(recorded)).toEqual({ db: 2, "db.cache": 3, "db.sessions": 4 });
		expect(withRecordedDbIndexes(base, {})).toEqual(base);
		expect(recordedDbIndexes(base)).toEqual({});
	});
});

describe("env resolution with declared uses", () => {
	const launch = mk(`${START}requires:
  - type: redis
    uses: [db, pubsub]
    set_env:
      CACHE_URL: $redis.db.url
      CACHE_DB: $redis.db.index
      REDIS_URL: $url
`);
	const component = launch.components.default!;
	const resourceMap: Record<string, ResourceProperties> = {
		redis: withCoveredUses(
			"redis",
			["db", "pubsub"],
			{ url: "redis://localhost:6379/0", host: "localhost", port: 6379, password: "" },
			{ db: 0 },
		),
	};

	it("collects the declared use keys per resource name", () => {
		expect(declaredUses(launch)).toEqual({ redis: ["db", "pubsub"] });
		expect(declaredUses(mk(`${START}requires:\n  - type: redis\n    uses: [{db: cache}, pubsub, {db: sessions}]\n`))).toEqual({
			redis: ["db.cache", "pubsub", "db.sessions"],
		});
	});

	it("resolves the three-segment form from the registered keys", () => {
		const context = buildResolverContext(resourceMap, {}, {}, {}, {}, declaredUses(launch));
		const { env } = resolveComponentEnv(component, context, resourceMap);
		expect(env).toEqual({
			CACHE_URL: "redis://localhost:6379/0",
			CACHE_DB: "0",
			REDIS_URL: "redis://localhost:6379/0",
		});
	});

	it("throws on a use the entry does not declare instead of falling back to the instance url", () => {
		const wrong = mk(`${START}requires:
  - type: redis
    uses: [pubsub]
    set_env:
      CACHE_URL: $redis.db.url
`);
		const map: Record<string, ResourceProperties> = {
			redis: withCoveredUses("redis", ["pubsub"], { url: "redis://localhost:6379/0" }, {}),
		};
		const context = buildResolverContext(map, {}, {}, {}, {}, declaredUses(wrong));
		expect(() => resolveComponentEnv(wrong.components.default!, context, map)).toThrow(UnresolvedUseError);
	});

	it("keeps the last-segment fallback for a resource that declares no uses", () => {
		const plain = mk(`${START}requires:
  - type: redis
    set_env:
      DEEP: $redis.deep.host
`);
		const map: Record<string, ResourceProperties> = { redis: { url: "redis://localhost:6379/0", host: "localhost" } };
		const context = buildResolverContext(map, {}, {}, {}, {}, declaredUses(plain));
		expect(resolveComponentEnv(plain.components.default!, context, map).env).toEqual({ DEEP: "localhost" });
	});
});

describe("env resolution with named uses — `- db: cache` (D-65 rule 6)", () => {
	const launch = mk(`${START}requires:
  - type: redis
    uses: [{db: sessions}, {db: cache}, pubsub]
    set_env:
      CACHE_URL: $redis.db.cache.url
      CACHE_DB: $redis.db.cache.index
      SESSIONS_URL: $redis.db.sessions.url
      REDIS_URL: $url
`);
	const uses = declaredUses(launch);
	const redis: ResourceProperties = { url: "redis://localhost:6379/0", host: "localhost", port: 6379, password: "" };

	it("registers each name from its own allocated index — never the same one", () => {
		const indexes = allocateDbIndexes(launch).redis!;
		const map = { redis: registerResource("redis", "redis", uses, redis, indexes) };
		const context = buildResolverContext(map, {}, {}, {}, {}, uses);
		expect(resolveComponentEnv(launch.components.default!, context, map).env).toEqual({
			CACHE_URL: "redis://localhost:6379/0",
			CACHE_DB: "0",
			SESSIONS_URL: "redis://localhost:6379/1",
			REDIS_URL: "redis://localhost:6379/0",
		});
	});

	it("throws on the bare $redis.db.url when every db is named — never the instance url or a named one", () => {
		const wrong = mk(`${START}requires:
  - type: redis
    uses: [{db: cache}]
    set_env:
      CACHE_URL: $redis.db.url
`);
		const map = { redis: registerResource("redis", "redis", declaredUses(wrong), redis, { "db.cache": 0 }) };
		const context = buildResolverContext(map, {}, {}, {}, {}, declaredUses(wrong));
		expect(() => resolveComponentEnv(wrong.components.default!, context, map)).toThrow(
			'$redis.db.url does not resolve: redis declares no use "db" (declared: db: cache)',
		);
	});

	it("leaves a named db unregistered when state records no index for it, so the reference throws", () => {
		const map = { redis: registerResource("redis", "redis", uses, redis, { "db.cache": 0 }) };
		expect(map.redis["db.cache.index"]).toBe(0);
		expect(map.redis).not.toHaveProperty("db.sessions.index");
		const context = buildResolverContext(map, {}, {}, {}, {}, uses);
		expect(() => resolveComponentEnv(launch.components.default!, context, map)).toThrow(UnresolvedUseError);
	});
});
