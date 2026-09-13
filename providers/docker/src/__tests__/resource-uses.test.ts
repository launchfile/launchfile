/**
 * Declared `uses` on a `requires`/`supports` entry (SPEC.md § Resource uses):
 * this provider covers every declared use — registering each one's
 * `<use>.<property>` keys — or refuses the component before anything of it is
 * emitted (D-56 rule 1, D-64). Every refusal test asserts the outcome (the
 * service is absent), never only the message. Files with no `uses` produce
 * byte-identical output (P-13), pinned at the end.
 */

import { RESOURCE_USE_VOCABULARY, readLaunch, UnresolvedUseError } from "@launchfile/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	type ComposeOpts,
	launchToCompose,
	resourcePropertyKeys,
} from "../compose-generator.js";
import { clearRegisteredSecrets, REDACTED, redactSecrets } from "../redact.js";
import {
	COVERED_TYPES,
	coverUse,
	coveredUses,
	uncoveredProvisionedUses,
	uncoveredSuppliedUses,
	usePropertyKeys,
} from "../resource-uses.js";

interface ComposeDoc {
	services: Record<
		string,
		{
			image?: string;
			environment?: Record<string, string>;
			depends_on?: Record<string, { condition: string }>;
		}
	>;
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
		expect(coverUse("redis", "db", { url: "redis://h:6379" }, 3)).toEqual({
			"db.url": "redis://h:6379/3",
			"db.index": "3",
		});
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
			expect(uncoveredProvisionedUses(type, ["nosuchuse"])).toEqual(["nosuchuse"]);
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
});
