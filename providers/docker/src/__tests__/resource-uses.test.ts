/**
 * Declared `uses` on a `requires`/`supports` entry (SPEC.md § Resource uses):
 * this provider covers every declared use — registering each one's
 * `<use>.<property>` keys — or refuses the component before anything of it is
 * emitted (D-56 rule 1, D-64). Every refusal test asserts the outcome (the
 * service is absent), never only the message. Files with no `uses` produce
 * byte-identical output (P-13), pinned at the end.
 */

import { isRepeatableUse, RESOURCE_USE_VOCABULARY, readLaunch, UnresolvedUseError } from "@launchfile/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	type ComposeOpts,
	launchToCompose,
	resourcePropertyKeys,
} from "../compose-generator.js";
import { clearRegisteredSecrets, REDACTED, redactSecrets } from "../redact.js";
import {
	allocateDbIndexes,
	COVERED_TYPES,
	coverUse,
	coveredUses,
	namedDatabase,
	namedDatabases,
	repeatableUses,
	uncoveredProvisionedUses,
	uncoveredSuppliedUses,
	usePropertyKeys,
	withDatabasePath,
} from "../resource-uses.js";

interface ComposeDoc {
	services: Record<
		string,
		{
			image?: string;
			environment?: Record<string, string>;
			depends_on?: Record<string, { condition: string }>;
			configs?: { source: string; target: string }[];
		}
	>;
	configs?: Record<string, { content: string }>;
}

const compose = (yaml: string, opts: ComposeOpts = {}) => {
	const result = launchToCompose(readLaunch(yaml), opts);
	return { ...result, doc: parse(result.yaml) as ComposeDoc };
};

const refusals = (warnings: string[]) => warnings.filter((w) => w.startsWith("refused:"));

beforeEach(() => {
	clearRegisteredSecrets();
});

const REDIS_DB_PUBSUB = `
name: app
image: acme/app:1
requires:
  - type: redis
    uses: [db, pubsub]
    set_env:
      CACHE_URL: $redis.db.url
      CACHE_DB: $redis.db.index
      REDIS_URL: $url
      REDIS_HOST: $redis.host
`;

describe("redis uses: db and pubsub on the provisioned instance", () => {
	it("registers db.url and db.index and resolves the three-segment form", () => {
		const { doc, warnings } = compose(REDIS_DB_PUBSUB);
		expect(refusals(warnings)).toEqual([]);
		expect(doc.services.app!.environment).toEqual({
			CACHE_URL: "redis://app-redis:6379/0",
			CACHE_DB: "0",
			REDIS_URL: "redis://app-redis:6379",
			REDIS_HOST: "app-redis",
		});
	});

	it("still emits the backing service and its readiness gate", () => {
		const { doc } = compose(REDIS_DB_PUBSUB);
		expect(doc.services["app-redis"]?.image).toBe("redis:7-alpine");
		expect(doc.services.app!.depends_on).toEqual({
			"app-redis": { condition: "service_healthy" },
		});
	});

	it("allocates one database index per entry, in declaration order", () => {
		const { doc } = compose(`
name: app
image: acme/app:1
requires:
  - type: redis
    name: cache
    uses: [db]
    set_env:
      CACHE_URL: $cache.db.url
  - type: redis
    name: sessions
    uses: [db]
    set_env:
      SESSIONS_URL: $sessions.db.url
      SESSIONS_DB: $sessions.db.index
`);
		expect(doc.services.app!.environment).toEqual({
			CACHE_URL: "redis://app-redis:6379/0",
			SESSIONS_URL: "redis://app-redis:6379/1",
			SESSIONS_DB: "1",
		});
	});

	it("covers server with the instance and registers nothing for it", () => {
		const { doc, warnings } = compose(`
name: app
image: acme/app:1
requires:
  - type: redis
    uses: [server]
    set_env:
      REDIS_URL: $url
`);
		expect(refusals(warnings)).toEqual([]);
		expect(doc.services.app!.environment).toEqual({ REDIS_URL: "redis://app-redis:6379" });
	});
});

describe("postgres uses: database on the provisioned server", () => {
	it("registers database.url and database.name", () => {
		const { doc } = compose(`
name: app
image: acme/app:1
requires:
  - type: postgres
    uses: [database, server]
    set_env:
      DB_URL: $postgres.database.url
      DB_NAME: $postgres.database.name
      SERVER_HOST: $host
`);
		const env = doc.services.app!.environment!;
		expect(env.DB_NAME).toBe("app");
		expect(env.DB_URL).toMatch(/^postgres:\/\/launchfile:.+@app-postgres:5432\/app\?sslmode=disable$/);
		expect(env.SERVER_HOST).toBe("app-postgres");
	});
});

describe("a use this provider cannot cover refuses the component", () => {
	const UNKNOWN = `
name: app
image: acme/app:1
requires:
  - type: redis
    uses: [nosuchuse]
    set_env:
      REDIS_URL: $url
`;

	it("refuses: no service, no image, no environment", () => {
		const { doc, images, warnings } = compose(UNKNOWN);
		expect(doc.services.app).toBeUndefined();
		expect(doc.services["app-redis"]).toBeUndefined();
		expect(images).toEqual([]);
		expect(refusals(warnings)).toHaveLength(1);
	});

	it("names the component, the entry, the use, and the ways out", () => {
		const [refusal] = refusals(compose(UNKNOWN).warnings);
		expect(refusal).toBe(
			"refused: default requires a use of a resource this provider cannot cover " +
				"(redis: nosuchuse (not a use this provider covers for redis)) — a provider covers " +
				"every declared use or refuses; declare only what the app uses, supply a resource " +
				"that covers it through the provider's supplied-resource channel (D-56), or use a " +
				"provider that covers it — component skipped",
		);
	});

	it("refuses a recognised token on a type this provider provisions without that feature", () => {
		// `database` is a postgres use, not a redis one.
		const { doc, warnings } = compose(`
name: app
image: acme/app:1
requires:
  - type: redis
    uses: [database]
`);
		expect(doc.services.app).toBeUndefined();
		expect(refusals(warnings)[0]).toContain("redis: database (not a use this provider covers for redis)");
	});

	it("keeps siblings that declare only covered uses", () => {
		const { doc, warnings } = compose(`
name: app
components:
  web:
    image: acme/web:1
    requires:
      - type: redis
        uses: [db]
        set_env:
          CACHE_URL: $redis.db.url
  worker:
    image: acme/worker:1
    requires:
      - type: redis
        uses: [nosuchuse]
`);
		expect(doc.services["app-web"]?.environment?.CACHE_URL).toBe("redis://app-redis:6379/0");
		expect(doc.services["app-worker"]).toBeUndefined();
		expect(refusals(warnings)).toHaveLength(1);
		expect(refusals(warnings)[0]).toMatch(/^refused: worker /);
	});

	it("refuses on the type first when the type has no factory at all", () => {
		const { warnings } = compose(`
name: app
image: acme/app:1
requires:
  - type: snowflake
    uses: [warehouse]
`);
		expect(refusals(warnings)).toHaveLength(1);
		expect(refusals(warnings)[0]).toContain("cannot provision (snowflake)");
	});
});

describe("a reference to a use the entry does not declare is an error, never a fallback", () => {
	it("throws UnresolvedUseError instead of handing back the instance url", () => {
		expect(() =>
			compose(`
name: app
image: acme/app:1
requires:
  - type: redis
    uses: [pubsub]
    set_env:
      CACHE_URL: $redis.db.url
`),
		).toThrow(UnresolvedUseError);
	});

	it("throws on a property the use does not register", () => {
		expect(() =>
			compose(`
name: app
image: acme/app:1
requires:
  - type: redis
    uses: [db]
    set_env:
      CACHE_HOST: $redis.db.host
`),
		).toThrow('use "db" on redis registers no property "host"');
	});

	it("throws from an env: default on another component too", () => {
		expect(() =>
			compose(`
name: app
components:
  web:
    image: acme/web:1
    env:
      CACHE_URL: $redis.cache.url
  worker:
    image: acme/worker:1
    requires:
      - type: redis
        uses: [db]
`),
		).toThrow(UnresolvedUseError);
	});
});

describe("supplied resources with declared uses (D-56 rule 1)", () => {
	const APP = `
name: app
image: acme/app:1
requires:
  - type: redis
    uses: [db, pubsub]
    set_env:
      CACHE_URL: $redis.db.url
      CACHE_DB: $redis.db.index
      REDIS_URL: $url
`;
	const covering: ComposeOpts["resources"] = {
		redis: {
			properties: {
				url: "redis://:s3cret@cache.internal:6379",
				host: "cache.internal",
				port: "6379",
				password: "s3cret",
				"db.url": "redis://:s3cret@cache.internal:6379/7",
				"db.index": "7",
			},
		},
	};

	it("accepts a supplied map that carries every registered <use>.<property> key", () => {
		const { doc, warnings } = compose(APP, { resources: covering });
		expect(refusals(warnings)).toEqual([]);
		expect(doc.services["app-redis"]).toBeUndefined();
		expect(doc.services.app!.environment).toEqual({
			CACHE_URL: "redis://:s3cret@cache.internal:6379/7",
			CACHE_DB: "7",
			REDIS_URL: "redis://:s3cret@cache.internal:6379",
		});
	});

	it("refuses when the supplied map lacks a declared use's registered key — the provider refuses on what it can observe", () => {
		const { doc, warnings } = compose(APP, {
			resources: {
				redis: { properties: { url: "redis://cache.internal:6379", host: "cache.internal", port: "6379", password: "" } },
			},
		});
		expect(doc.services.app).toBeUndefined();
		expect(refusals(warnings)[0]).toContain("redis: db (the supplied resource lacks db.url, db.index)");
	});

	it("refuses a token it does not recognise even when a resource is supplied", () => {
		const { doc, warnings } = compose(
			`
name: app
image: acme/app:1
requires:
  - type: redis
    uses: [nosuchuse]
`,
			{ resources: { redis: { properties: { url: "redis://cache.internal:6379" } } } },
		);
		expect(doc.services.app).toBeUndefined();
		expect(refusals(warnings)[0]).toContain("redis: nosuchuse (not a use this provider recognises)");
	});

	it("does not register a use's registered keys as secrets — a bare index would mask every matching digit", () => {
		compose(APP, { resources: covering });
		expect(redactSecrets("index 7 on port 6379")).toBe("index 7 on port 6379");
		// The password still registers, as always.
		expect(redactSecrets("password s3cret")).not.toContain("s3cret");
	});

	it("scrubs the credential inside a supplied db.url by pattern, as it does the instance url (D-56 rule 5)", () => {
		clearRegisteredSecrets();
		compose(APP, {
			resources: {
				redis: {
					properties: {
						url: "redis://app:pw-only-in-the-url@cache.internal:6379",
						"db.url": "redis://app:pw-only-in-the-url@cache.internal:6379/7",
						"db.index": "7",
					},
				},
			},
		});
		// Nothing registered the URL's password as a literal: only the pattern covers it.
		expect(redactSecrets("db 7")).toBe("db 7");
		expect(redactSecrets("redis://app:pw-only-in-the-url@cache.internal:6379/7")).toBe(
			`redis://app:${REDACTED}@cache.internal:6379/7`,
		);
	});
});

describe("mariadb: the provisioned and supplied paths agree", () => {
	const APP = `
name: mdb
image: acme/app:1
requires:
  - type: mariadb
    uses: [database]
    set_env:
      DB_URL: $mariadb.database.url
      DB_NAME: $mariadb.database.name
`;

	it("provisions mariadb and registers database.url and database.name", () => {
		const { doc, warnings } = compose(APP);
		expect(refusals(warnings)).toEqual([]);
		expect(doc.services["mdb-mariadb"]?.image).toBe("mariadb:11");
		expect(doc.services.mdb!.environment!.DB_NAME).toBe("mdb");
		expect(doc.services.mdb!.environment!.DB_URL).toMatch(/^mysql:\/\/launchfile:.+@mdb-mariadb:3306\/mdb$/);
	});

	it("accepts a supplied mariadb map that carries database.url and database.name", () => {
		const { doc, warnings } = compose(APP, {
			resources: {
				mariadb: {
					properties: {
						url: "mysql://app:pw@db.internal:3306/managed",
						name: "managed",
						"database.url": "mysql://app:pw@db.internal:3306/managed",
						"database.name": "managed",
					},
				},
			},
		});
		expect(refusals(warnings)).toEqual([]);
		expect(doc.services["mdb-mariadb"]).toBeUndefined();
		expect(doc.services.mdb!.environment).toEqual({
			DB_URL: "mysql://app:pw@db.internal:3306/managed",
			DB_NAME: "managed",
		});
	});

	it("still refuses a supplied mariadb map that lacks a registered key", () => {
		const { doc, warnings } = compose(APP, {
			resources: { mariadb: { properties: { url: "mysql://app:pw@db.internal:3306/managed" } } },
		});
		expect(doc.services.mdb).toBeUndefined();
		expect(refusals(warnings)[0]).toContain(
			"mariadb: database (the supplied resource lacks database.url, database.name)",
		);
	});
});

describe("same-name entries pool their uses (D-24)", () => {
	it("keeps every entry's registered keys when a later entry declares fewer", () => {
		const { doc } = compose(`
name: app
components:
  web:
    image: acme/web:1
    requires:
      - type: redis
        uses: [db]
        set_env:
          CACHE_URL: $redis.db.url
  worker:
    image: acme/worker:1
    requires:
      - type: redis
        uses: [pubsub]
        set_env:
          PUBSUB_URL: $url
  api:
    image: acme/api:1
    env:
      CACHE_URL: $redis.db.url
`);
		expect(doc.services["app-web"]!.environment!.CACHE_URL).toBe("redis://app-redis:6379/0");
		expect(doc.services["app-worker"]!.environment!.PUBSUB_URL).toBe("redis://app-redis:6379");
		expect(doc.services["app-api"]!.environment!.CACHE_URL).toBe("redis://app-redis:6379/0");
	});

	it("registers nothing for a pooled token only an unfulfilled supports entry declares", () => {
		const { doc, warnings } = compose(`
name: app
components:
  web:
    image: acme/web:1
    requires:
      - type: redis
        uses: [db]
        set_env:
          CACHE_URL: $redis.db.url
  worker:
    image: acme/worker:1
    supports:
      - type: redis
        uses: [nosuchuse]
        set_env:
          X: $redis.nosuchuse.thing
`);
		expect(refusals(warnings)).toEqual([]);
		expect(doc.services["app-web"]!.environment!.CACHE_URL).toBe("redis://app-redis:6379/0");
		expect(doc.services["app-worker"]!.environment?.X).toBeUndefined();
	});
});

describe("supports: an uncovered use leaves the entry unfulfilled, never refused (D-8)", () => {
	const APP = `
name: app
image: acme/app:1
supports:
  - type: redis
    uses: [db]
    set_env:
      CACHE_URL: $redis.db.url
`;

	it("deploys the component with the binding absent when the supplied map lacks the use", () => {
		const { doc, warnings } = compose(APP, {
			resources: { redis: { properties: { url: "redis://cache.internal:6379" } } },
		});
		expect(doc.services.app!.image).toBe("acme/app:1");
		expect(doc.services.app!.environment).toBeUndefined();
		expect(refusals(warnings)).toEqual([]);
		expect(warnings).toContainEqual(
			"default: optional resource redis is not satisfied — the supplied resource does not cover " +
				"every declared use (db (the supplied resource lacks db.url, db.index)); its set_env " +
				"bindings are omitted and the app runs degraded",
		);
	});

	it("injects the binding when the supplied map covers the use", () => {
		const { doc } = compose(APP, {
			resources: {
				redis: {
					properties: { url: "redis://cache.internal:6379", "db.url": "redis://cache.internal:6379/2", "db.index": "2" },
				},
			},
		});
		expect(doc.services.app!.environment).toEqual({ CACHE_URL: "redis://cache.internal:6379/2" });
	});

	it("keeps the existing not-satisfied warning when nothing is supplied", () => {
		const { doc, warnings } = compose(APP);
		expect(doc.services.app!.environment).toBeUndefined();
		expect(warnings.some((w) => w.includes("none was supplied"))).toBe(true);
	});
});

describe("files with no uses are byte-identical (P-13)", () => {
	const PLAIN = `
name: app
image: acme/app:1
requires:
  - type: redis
    set_env:
      REDIS_URL: $url
      REDIS_HOST: $redis.host
  - type: postgres
    set_env:
      DATABASE_URL: $url
`;

	it("registers no <use>.<property> key on an entry that declares none", () => {
		const { doc, yaml } = compose(PLAIN);
		expect(doc.services.app!.environment).toEqual({
			REDIS_URL: "redis://app-redis:6379",
			REDIS_HOST: "app-redis",
			DATABASE_URL: expect.stringMatching(/^postgres:\/\//),
		});
		expect(yaml).not.toMatch(/\bdb\./);
		expect(yaml).not.toMatch(/\bdatabase\./);
	});

	it("keeps the factories' property vocabularies unchanged", () => {
		const keys = resourcePropertyKeys();
		expect(keys.redis).toEqual(["host", "port", "password", "url"]);
		expect(keys.postgres).toEqual(["host", "port", "user", "password", "name", "url"]);
	});

	it("keeps the dotted-key → last-segment fallback for such an entry", () => {
		const { doc } = compose(`
name: app
image: acme/app:1
requires:
  - type: redis
    set_env:
      DEEP: $redis.deep.host
`);
		expect(doc.services.app!.environment).toEqual({ DEEP: "app-redis" });
	});
});

describe("coverage helpers", () => {
	it("registers db.url as the instance url with the index as its path", () => {
		expect(coverUse("redis", "db", { url: "redis://h:6379" }, { db: 3 })).toEqual({
			"db.url": "redis://h:6379/3",
			"db.index": "3",
		});
	});

	it("registers a named db under its name, with the index allocated to that key", () => {
		expect(coverUse("redis", "db.cache", { url: "redis://h:6379" }, { db: 0, "db.cache": 2 })).toEqual({
			"db.cache.url": "redis://h:6379/2",
			"db.cache.index": "2",
		});
	});

	it("registers a named database as <instance>_<name> with the url's path swapped", () => {
		const base = { url: "postgres://u:p@h:5432/app?sslmode=disable", name: "app" };
		expect(coverUse("postgres", "database.reports", base, {})).toEqual({
			"database.reports.url": "postgres://u:p@h:5432/app_reports?sslmode=disable",
			"database.reports.name": "app_reports",
		});
		expect(coverUse("mysql", "database.event-log", { url: "mysql://u:p@h:3306/app", name: "app" }, {})).toEqual({
			"database.event-log.url": "mysql://u:p@h:3306/app_event_log",
			"database.event-log.name": "app_event_log",
		});
	});

	it("does not cover a name on a use that does not repeat", () => {
		expect(coverUse("redis", "pubsub.events", { url: "redis://h:6379" }, {})).toBeUndefined();
		expect(coverUse("mariadb", "server.main", { url: "mysql://h/app" }, {})).toBeUndefined();
		expect(uncoveredProvisionedUses("mariadb", ["server.main", "database.x"])).toEqual([
			"server: main (server on mariadb is not repeatable and takes no name)",
		]);
	});

	it("repeats exactly the uses the standard vocabulary marks repeatable", () => {
		for (const [type, uses] of Object.entries(RESOURCE_USE_VOCABULARY)) {
			for (const use of Object.keys(uses)) {
				expect(repeatableUses(type).includes(use), `${type}.${use}`).toBe(isRepeatableUse(type, use));
			}
		}
		expect(repeatableUses("mariadb")).toEqual(["database"]);
	});

	it("names databases and swaps url paths the same way for every engine", () => {
		expect(namedDatabase("my-app", "event-log")).toBe("my-app_event_log");
		expect(withDatabasePath("postgres://u:p@h:5432/app?sslmode=disable", "app_x")).toBe(
			"postgres://u:p@h:5432/app_x?sslmode=disable",
		);
		expect(withDatabasePath("mysql://u:p@h:3306", "app_x")).toBe("mysql://u:p@h:3306/app_x");
		expect(namedDatabases(["database", "database.b", "db.a", "database.a", "database.b"])).toEqual(["a", "b"]);
	});

	it("lists the keys of the uses this provider covers only", () => {
		expect(usePropertyKeys("redis", ["db", "pubsub", "nosuch"])).toEqual(["db.url", "db.index"]);
		expect(usePropertyKeys("kafka", ["topics"])).toEqual([]);
	});

	it("covers every use the standard vocabulary registers, with exactly the registry's keys", () => {
		for (const [type, uses] of Object.entries(RESOURCE_USE_VOCABULARY)) {
			expect([...coveredUses(type)].sort()).toEqual(Object.keys(uses).sort());
			for (const [use, properties] of Object.entries(uses)) {
				expect(usePropertyKeys(type, [use])).toEqual(properties.map((prop) => `${use}.${prop}`));
			}
		}
	});

	it("reaches the same verdict on the provisioned and supplied paths for every type it covers", () => {
		expect(COVERED_TYPES).toContain("mariadb");
		for (const type of COVERED_TYPES) {
			const uses = coveredUses(type);
			expect(uses.length).toBeGreaterThan(0);
			const supplied = Object.fromEntries(usePropertyKeys(type, uses).map((key) => [key, "v"]));
			expect(uncoveredProvisionedUses(type, uses)).toEqual([]);
			expect(uncoveredSuppliedUses(type, uses, supplied)).toEqual([]);
			expect(uncoveredProvisionedUses(type, ["nosuchuse"])).toEqual([
				`nosuchuse (not a use this provider covers for ${type})`,
			]);
			expect(uncoveredSuppliedUses(type, ["nosuchuse"], supplied)).toEqual([
				"nosuchuse (not a use this provider recognises)",
			]);
		}
	});

	it("reports each shortfall of a supplied map", () => {
		expect(uncoveredSuppliedUses("redis", ["db", "pubsub", "x"], { "db.url": "u" })).toEqual([
			"db (the supplied resource lacks db.index)",
			"x (not a use this provider recognises)",
		]);
	});

	it("reports a named use's shortfall naming the token and the name (D-64)", () => {
		expect(
			uncoveredSuppliedUses("redis", ["db.cache", "db.sessions", "pubsub.x"], {
				"db.cache.url": "u",
				"db.cache.index": "1",
			}),
		).toEqual([
			"db: sessions (the supplied resource lacks db.sessions.url, db.sessions.index)",
			"pubsub: x (pubsub on redis is not repeatable and takes no name)",
		]);
	});
});

describe("allocateDbIndexes — one rule, shared with macos-dev", () => {
	it("gives the bare db the first index of a resource's block and the named dbs the rest in name order", () => {
		const launch = readLaunch(`
name: app
image: acme/app:1
requires:
  - type: redis
    uses: [{db: sessions}, {db: cache}, pubsub]
`);
		expect(allocateDbIndexes(launch)).toEqual({ redis: { "db.cache": 0, "db.sessions": 1 } });
	});

	it("orders resources by their first db-declaring entry, components in file order, requires before supports", () => {
		const launch = readLaunch(`
name: app
components:
  web:
    image: acme/web:1
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
    image: acme/worker:1
    requires:
      - type: redis
        name: main
        uses: [{db: cache}]
  api:
    image: acme/api:1
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
		const launch = readLaunch(`
name: app
image: acme/app:1
requires:
  - type: redis
    uses: [pubsub]
  - type: postgres
    uses: [{database: a}]
`);
		expect(allocateDbIndexes(launch)).toEqual({});
	});
});

describe("named uses: `- db: cache` on the provisioned instance", () => {
	const NAMED = `
name: app
image: acme/app:1
requires:
  - type: redis
    uses: [{db: cache}, {db: sessions}, pubsub]
    set_env:
      CACHE_URL: $redis.db.cache.url
      CACHE_DB: $redis.db.cache.index
      SESSIONS_URL: $redis.db.sessions.url
      SESSIONS_DB: $redis.db.sessions.index
      PUBSUB_URL: $url
`;

	it("resolves each name to its own database index — never the same one", () => {
		const { doc, warnings } = compose(NAMED);
		expect(refusals(warnings)).toEqual([]);
		expect(doc.services.app!.environment).toEqual({
			CACHE_URL: "redis://app-redis:6379/0",
			CACHE_DB: "0",
			SESSIONS_URL: "redis://app-redis:6379/1",
			SESSIONS_DB: "1",
			PUBSUB_URL: "redis://app-redis:6379",
		});
	});

	it("allocates a resource's bare db before its named dbs, and the next resource after", () => {
		const { doc } = compose(`
name: app
image: acme/app:1
requires:
  - type: redis
    name: cache
    uses: [{db: sessions}]
    set_env:
      SESSIONS: $cache.db.sessions.index
  - type: redis
    name: queue
    uses: [db]
    set_env:
      QUEUE: $queue.db.index
`);
		expect(doc.services.app!.environment).toEqual({ SESSIONS: "0", QUEUE: "1" });
	});

	it("throws on the bare $redis.db.url when every db is named — never the instance url or a named one", () => {
		expect(() =>
			compose(`
name: app
image: acme/app:1
requires:
  - type: redis
    uses: [{db: cache}]
    set_env:
      CACHE_URL: $redis.db.url
`),
		).toThrow('$redis.db.url does not resolve: redis declares no use "db" (declared: db: cache)');
	});

	it("throws on a name the entry does not declare", () => {
		expect(() =>
			compose(`
name: app
image: acme/app:1
requires:
  - type: redis
    uses: [{db: cache}]
    set_env:
      X: $redis.db.nosuch.url
`),
		).toThrow(UnresolvedUseError);
	});

	it("refuses a name on a use that does not repeat on a type outside the registry, naming token and name", () => {
		// mariadb has no registry entry, so the schema lets the name through;
		// this provider knows `server` does not repeat and refuses.
		const { doc, warnings } = compose(`
name: app
image: acme/app:1
requires:
  - type: mariadb
    uses: [{server: main}]
`);
		expect(doc.services.app).toBeUndefined();
		expect(refusals(warnings)[0]).toContain(
			"mariadb: server: main (server on mariadb is not repeatable and takes no name)",
		);
	});
});

describe("named uses: `- database: reports` on the provisioned SQL server", () => {
	const PG = `
name: app
image: acme/app:1
requires:
  - type: postgres
    uses: [{database: reports}, {database: audit-log}, server]
    set_env:
      DB_URL: $url
      DB_NAME: $name
      REPORTS_URL: $postgres.database.reports.url
      REPORTS_NAME: $postgres.database.reports.name
      AUDIT_NAME: $postgres.database.audit-log.name
`;

	it("registers each named database as <instance>_<name> with its own url; the instance keeps its own", () => {
		const { doc, warnings } = compose(PG);
		expect(refusals(warnings)).toEqual([]);
		const env = doc.services.app!.environment!;
		expect(env.DB_NAME).toBe("app");
		expect(env.REPORTS_NAME).toBe("app_reports");
		expect(env.AUDIT_NAME).toBe("app_audit_log");
		expect(env.REPORTS_URL).toMatch(/^postgres:\/\/launchfile:.+@app-postgres:5432\/app_reports\?sslmode=disable$/);
		expect(env.DB_URL).toMatch(/\/app\?sslmode=disable$/);
	});

	it("creates the named databases through an init script on the server, and reports it as init-only", () => {
		const { doc, initOnlyDatabases } = compose(PG);
		expect(doc.services["app-postgres"]!.configs).toEqual([
			{ source: "app-postgres-databases", target: "/docker-entrypoint-initdb.d/91-launchfile-databases.sql" },
		]);
		expect(doc.configs!["app-postgres-databases"]!.content).toBe(
			'CREATE DATABASE "app_audit_log" OWNER "launchfile";\nCREATE DATABASE "app_reports" OWNER "launchfile";\n',
		);
		expect(initOnlyDatabases).toEqual([
			{
				component: "default",
				service: "app-postgres",
				volume: "app-postgres-data",
				databases: ["app_audit_log", "app_reports"],
			},
		]);
	});

	it("grants the service user on each named mysql database", () => {
		const { doc } = compose(`
name: app
image: acme/app:1
requires:
  - type: mysql
    uses: [{database: reports}]
    set_env:
      REPORTS_URL: $mysql.database.reports.url
`);
		expect(doc.configs!["app-mysql-databases"]!.content).toBe(
			"CREATE DATABASE IF NOT EXISTS `app_reports`;\nGRANT ALL PRIVILEGES ON `app_reports`.* TO 'launchfile'@'%';\n",
		);
		expect(doc.services.app!.environment!.REPORTS_URL).toMatch(/@app-mysql:3306\/app_reports$/);
	});

	it("pools named databases from every entry of the type — one server serves them all", () => {
		const { doc } = compose(`
name: app
components:
  web:
    image: acme/web:1
    requires:
      - type: postgres
        uses: [{database: reports}]
  worker:
    image: acme/worker:1
    requires:
      - type: postgres
        name: analytics
        uses: [{database: events}]
`);
		expect(doc.configs!["app-postgres-databases"]!.content).toBe(
			'CREATE DATABASE "app_events" OWNER "launchfile";\nCREATE DATABASE "app_reports" OWNER "launchfile";\n',
		);
	});

	it("emits no init script and reports nothing when no database is named", () => {
		const { doc, initOnlyDatabases } = compose(`
name: app
image: acme/app:1
requires:
  - type: postgres
    uses: [database]
`);
		expect(doc.services["app-postgres"]!.configs).toBeUndefined();
		expect(doc.configs).toBeUndefined();
		expect(initOnlyDatabases).toEqual([]);
	});

	it("pools only from entries it provisions — a supports entry's named database never reaches the init script", () => {
		// The supports entry is unfulfilled (nothing supplied), so its database
		// belongs to no server this provider stands up.
		const { doc, warnings, initOnlyDatabases } = compose(`
name: app
image: acme/app:1
requires:
  - type: postgres
    uses: [{database: reports}]
supports:
  - type: postgres
    name: analytics
    uses: [{database: events}]
`);
		expect(refusals(warnings)).toEqual([]);
		expect(warnings.some((w) => w.includes("optional resource analytics is not satisfied"))).toBe(true);
		expect(doc.configs!["app-postgres-databases"]!.content).toBe(
			'CREATE DATABASE "app_reports" OWNER "launchfile";\n',
		);
		expect(initOnlyDatabases[0]!.databases).toEqual(["app_reports"]);
	});

	it("pools nothing from a supplied requires entry — its databases live on the orchestrator's server", () => {
		const { doc, warnings } = compose(
			`
name: app
image: acme/app:1
requires:
  - type: postgres
    uses: [{database: reports}]
  - type: postgres
    name: analytics
    uses: [{database: events}]
`,
			{
				resources: {
					analytics: {
						properties: {
							url: "postgres://a:pw@pg.internal:5432/analytics",
							"database.events.url": "postgres://a:pw@pg.internal:5432/analytics_events",
							"database.events.name": "analytics_events",
						},
					},
				},
			},
		);
		expect(refusals(warnings)).toEqual([]);
		expect(doc.configs!["app-postgres-databases"]!.content).toBe(
			'CREATE DATABASE "app_reports" OWNER "launchfile";\n',
		);
	});
});

describe("supplied resources with named uses (D-56 rule 1)", () => {
	const APP = `
name: app
image: acme/app:1
requires:
  - type: redis
    uses: [{db: cache}, {db: sessions}]
    set_env:
      CACHE_URL: $redis.db.cache.url
      SESSIONS_DB: $redis.db.sessions.index
`;

	it("accepts a map carrying every named use's registered keys", () => {
		const { doc, warnings } = compose(APP, {
			resources: {
				redis: {
					properties: {
						url: "redis://cache.internal:6379",
						"db.cache.url": "redis://cache.internal:6379/4",
						"db.cache.index": "4",
						"db.sessions.url": "redis://cache.internal:6379/5",
						"db.sessions.index": "5",
					},
				},
			},
		});
		expect(refusals(warnings)).toEqual([]);
		expect(doc.services.app!.environment).toEqual({
			CACHE_URL: "redis://cache.internal:6379/4",
			SESSIONS_DB: "5",
		});
	});

	it("refuses naming the entry, the token and the name when a named use's keys are missing", () => {
		const { doc, warnings } = compose(APP, {
			resources: {
				redis: {
					properties: {
						url: "redis://cache.internal:6379",
						"db.cache.url": "redis://cache.internal:6379/4",
						"db.cache.index": "4",
					},
				},
			},
		});
		expect(doc.services.app).toBeUndefined();
		expect(refusals(warnings)[0]).toContain(
			"redis: db: sessions (the supplied resource lacks db.sessions.url, db.sessions.index)",
		);
	});

	it("keeps a supplied db.<name>.index structural and scrubs the password inside db.<name>.url by pattern (D-56 rule 5, D-65)", () => {
		clearRegisteredSecrets();
		compose(APP, {
			resources: {
				redis: {
					properties: {
						url: "redis://app:pw-only-in-the-url@cache.internal:6379",
						"db.cache.url": "redis://app:pw-only-in-the-url@cache.internal:6379/4",
						"db.cache.index": "4",
						"db.sessions.url": "redis://app:pw-only-in-the-url@cache.internal:6379/5",
						"db.sessions.index": "5",
					},
				},
			},
		});
		// A named index registered as a secret would mask every matching digit.
		expect(redactSecrets("db 4 on port 6379, db 5 next")).toBe("db 4 on port 6379, db 5 next");
		// Nothing registered the URL's password as a literal: only the pattern covers it.
		expect(redactSecrets("redis://app:pw-only-in-the-url@cache.internal:6379/4")).toBe(
			`redis://app:${REDACTED}@cache.internal:6379/4`,
		);
	});
});
