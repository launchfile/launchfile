/**
 * Declared `uses` on a `requires`/`supports` entry (SPEC.md § Resource uses):
 * this provider covers every declared use — registering each one's
 * `<use>.<property>` keys — or refuses the component before anything is
 * provisioned, installed, wired or started (D-56 rule 1, D-64). It has no
 * supplied-resource channel, so cover-or-refuse are its only outcomes. The
 * outcome (the component is gone) is what is pinned, never only the message.
 */

import { readLaunch, UnresolvedUseError } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import {
	buildResolverContext,
	declaredUses,
	resolveComponentEnv,
} from "../env-writer.js";
import { applyResourceUseRefusals, refusedResourceUses } from "../provider.js";
import { clearRegisteredSecrets, REDACTED, redactSecrets } from "../redact.js";
import { coverUse, coveredUses, uncoveredUses, withCoveredUses } from "../resources/index.js";
import type { ResourceProperties } from "../resources/types.js";

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
	it("registers db.url with the allocated index in place of the instance's selector", () => {
		expect(coverUse("redis", "db", { url: "redis://localhost:6379/0", host: "localhost", port: 6379 }, 3)).toEqual({
			"db.url": "redis://localhost:6379/3",
			"db.index": 3,
		});
	});

	it("registers database.url and database.name for postgres", () => {
		const base: ResourceProperties = {
			url: "postgresql://u:p@localhost:5432/launchfile_app",
			name: "launchfile_app",
		};
		expect(coverUse("postgres", "database", base, 0)).toEqual({
			"database.url": base.url,
			"database.name": "launchfile_app",
		});
	});

	it("lists the uncovered tokens only", () => {
		expect(uncoveredUses("redis", ["db", "x", "pubsub", "y"])).toEqual(["x", "y"]);
	});

	it("lists the covered tokens only, in order — the pooled set a resource registers from", () => {
		expect(coveredUses("redis", ["pubsub", "x", "db"])).toEqual(["pubsub", "db"]);
		expect(coveredUses("kafka", ["topics"])).toEqual([]);
	});

	it("covers mariadb's database and server the way it covers mysql's", () => {
		const base: ResourceProperties = { url: "mysql://u:p@localhost:3306/launchfile_app", name: "launchfile_app" };
		expect(coverUse("mariadb", "database", base, 0)).toEqual(coverUse("mysql", "database", base, 0));
		expect(uncoveredUses("mariadb", ["database", "server", "nosuchuse"])).toEqual(["nosuchuse"]);
	});

	it("registers no use key with the redactor; a credential inside db.url is scrubbed by pattern (D-56 rule 5)", () => {
		clearRegisteredSecrets();
		const map = withCoveredUses(
			"redis",
			["db"],
			{ url: "redis://app:pw-only-in-the-url@localhost:6379/0", host: "localhost", port: 6379 },
			7,
		);
		expect(map["db.index"]).toBe(7);
		expect(redactSecrets("db 7 on port 6379")).toBe("db 7 on port 6379");
		expect(redactSecrets(String(map["db.url"]))).toBe(`redis://app:${REDACTED}@localhost:6379/7`);
	});

	it("leaves a map with no uses untouched — files without uses are byte-identical (P-13)", () => {
		const base: ResourceProperties = { url: "redis://localhost:6379/0", host: "localhost", port: 6379, password: "" };
		expect(withCoveredUses("redis", undefined, base, 0)).toEqual(base);
	});

	it("throws on an uncovered use — the caller must refuse first", () => {
		expect(() => withCoveredUses("redis", ["nosuchuse"], { url: "redis://localhost:6379" }, 0)).toThrow(
			/must refuse first/,
		);
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
			0,
		),
	};

	it("collects the declared uses per resource name", () => {
		expect(declaredUses(launch)).toEqual({ redis: ["db", "pubsub"] });
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
			redis: withCoveredUses("redis", ["pubsub"], { url: "redis://localhost:6379/0" }, 0),
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
