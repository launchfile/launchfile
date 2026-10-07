/**
 * The `uses` item decoders (SPEC.md § Resource uses): a bare token and a
 * single-key map both reduce to one use key, and the key splits back.
 */

import { describe, expect, it } from "vitest";
import { readLaunch } from "../reader.js";
import {
	allocateDbIndexes,
	declaredUse,
	formatUseKey,
	namedDatabase,
	parseUseKey,
	useKey,
	useKeyOf,
	useKeys,
	withDatabasePath,
} from "../uses.js";

describe("declaredUse", () => {
	it("decodes a bare token as an unnamed use", () => {
		expect(declaredUse("db")).toEqual({ use: "db" });
	});

	it("decodes a single-key map as a named use", () => {
		expect(declaredUse({ db: "cache" })).toEqual({ use: "db", name: "cache" });
	});
});

describe("useKey / useKeys", () => {
	it("keys a bare token by the token and a named use by token.name", () => {
		expect(useKey("db")).toBe("db");
		expect(useKey({ db: "cache" })).toBe("db.cache");
	});

	it("keys a decoded use through useKeyOf, and keys a token literally named `use` as an item, never as decoded", () => {
		expect(useKeyOf({ use: "db", name: "sessions" })).toBe("db.sessions");
		expect(useKeyOf({ use: "pubsub" })).toBe("pubsub");
		// A provider-defined token may be spelled `use`; `{ use: a }` is that
		// token named `a`, not an already-decoded `{ use: "a" }`.
		expect(useKey({ use: "a" })).toBe("use.a");
		expect(useKeys([{ use: "a" }, { use: "b" }])).toEqual(["use.a", "use.b"]);
	});

	it("keys a whole list in declaration order, and an absent list as empty", () => {
		expect(useKeys([{ db: "cache" }, "pubsub", { db: "sessions" }])).toEqual([
			"db.cache",
			"pubsub",
			"db.sessions",
		]);
		expect(useKeys(undefined)).toEqual([]);
	});
});

describe("parseUseKey / formatUseKey", () => {
	it("splits a key back into token and name", () => {
		expect(parseUseKey("db")).toEqual({ use: "db" });
		expect(parseUseKey("db.cache")).toEqual({ use: "db", name: "cache" });
	});

	it("spells a named key the way the file does", () => {
		expect(formatUseKey("db")).toBe("db");
		expect(formatUseKey("db.cache")).toBe("db: cache");
	});
});

describe("allocateDbIndexes — the one allocation every provider applies (D-65)", () => {
	it("orders blocks by first db-declaring entry, requires before supports, bare db first, then names in name order", () => {
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
        uses: [{db: retries}, {db: jobs}]
    supports:
      - type: redis
        name: optional
        uses: [db]
  worker:
    image: acme/worker:1
    requires:
      - type: redis
        name: main
        uses: [{db: sessions}, {db: cache}, pubsub]
  api:
    image: acme/api:1
    requires:
      - type: redis
        name: main
        uses: [db]
`);
		const allocation = allocateDbIndexes(launch);
		// `main` declares no db in web, so its block starts where worker declares one —
		// after `queue` (web's requires) and `optional` (web's supports, which takes its
		// index whether or not the entry is ever fulfilled). Within `main`, api's bare
		// db pools with worker's named ones (D-24) and takes the first index; the named
		// ones follow in name order, not declaration order.
		expect(allocation).toEqual({
			queue: { "db.jobs": 0, "db.retries": 1 },
			optional: { db: 2 },
			main: { db: 3, "db.cache": 4, "db.sessions": 5 },
		});
		expect(Object.keys(allocation)).toEqual(["queue", "optional", "main"]);
		expect(Object.keys(allocation.main ?? {})).toEqual([
			"db",
			"db.cache",
			"db.sessions",
		]);
	});

	it("has no entry for a resource that declares no db use, nor for a non-redis one", () => {
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

describe("namedDatabase / withDatabasePath", () => {
	it("names a named database use's database after the instance, hyphens as underscores", () => {
		expect(namedDatabase("my-app", "event-log")).toBe("my-app_event_log");
	});

	it("replaces the URL path, keeping the query and fragment, and leaves a non-URL alone", () => {
		expect(
			withDatabasePath("postgres://u:p@h:5432/app?sslmode=disable", "app_x"),
		).toBe("postgres://u:p@h:5432/app_x?sslmode=disable");
		expect(withDatabasePath("mysql://u:p@h:3306", "app_x")).toBe(
			"mysql://u:p@h:3306/app_x",
		);
		expect(withDatabasePath("not a url", "app_x")).toBe("not a url");
	});

	it("keeps a fragment, and a path with no query, and a bare authority with a query", () => {
		expect(withDatabasePath("postgres://h/app#frag", "app_x")).toBe(
			"postgres://h/app_x#frag",
		);
		expect(withDatabasePath("postgres://h/a/b", "app_x")).toBe(
			"postgres://h/app_x",
		);
		expect(withDatabasePath("postgres://h?x=1", "app_x")).toBe(
			"postgres://h/app_x?x=1",
		);
		expect(withDatabasePath("postgres://h/", "app_x")).toBe(
			"postgres://h/app_x",
		);
	});

	it("runs in linear time on a long authority followed by a newline", () => {
		const url = `a://${'"'.repeat(200_000)}?\n`;
		const started = performance.now();
		expect(withDatabasePath(url, "app_x")).toBe(
			`a://${'"'.repeat(200_000)}/app_x?\n`,
		);
		expect(performance.now() - started).toBeLessThan(500);
	});
});
