import { describe, it, expect } from "vitest";
import { readLaunch } from "../reader.js";
import { useKeys } from "../uses.js";
import { writeLaunch } from "../writer.js";

/*---
req: REQ-400
type: unit
status: implemented
area: launch-spec
summary: Parses Launchfile into normalized LaunchApp structures
rationale: |
  The reader is the entry point for Launchfile — every app descriptor
  passes through it. It must handle shorthand syntax (strings for build,
  health, requires) and expand them into full objects, plus support
  multi-component apps with field-level inheritance of top-level defaults
  onto every component (D-25), across all 17 component-eligible fields.
acceptance:
  - Reads a minimal 3-line app
  - Expands requires/build/health/depends_on/command string shorthands to objects
  - Expands scalar env values to objects
  - Reads multi-component apps with D-25 inheritance of all 17 component fields
  - Reads health with start_period, build target, singleton, schedule, storage, secrets, UDP
  - Throws on missing name or invalid runtime
tags: [launch-spec, reader, core]
source:
  type: implementation
  ref: implementation-discovery
changed:
  - date: 2026-03-28
    note: Backfilled by surface backfill
  - date: 2026-09-09
    note: D-25 inheritance extended from 7 to all 17 component fields (#233)
---*/
describe("readLaunch", () => {
	// UC-1: Minimal app
	it("reads a minimal 3-line app", () => {
		const result = readLaunch(`
version: launch/v1
name: my-api
runtime: node
commands:
  start: "node server.js"
`);
		expect(result.name).toBe("my-api");
		expect(result.version).toBe("launch/v1");
		expect(result.components.default?.runtime).toBe("node");
		expect(result.components.default?.commands?.start?.command).toBe("node server.js");
	});

	// UC-24: Minimal with database shorthand
	it("expands requires string shorthand", () => {
		const result = readLaunch(`
name: my-app
runtime: node
requires: [postgres]
commands:
  start: "node server.js"
`);
		expect(result.components.default?.requires).toEqual([{ type: "postgres" }]);
	});

	// UC-3: Individual database properties
	it("preserves set_env on requires", () => {
		const result = readLaunch(`
name: hedgedoc
requires:
  - type: postgres
    set_env:
      HD_DATABASE_URL: $url
      HD_DATABASE_USERNAME: $user
`);
		const req = result.components.default?.requires?.[0];
		expect(req?.set_env?.HD_DATABASE_URL).toBe("$url");
		expect(req?.set_env?.HD_DATABASE_USERNAME).toBe("$user");
	});

	it("reads uses on a requires entry", () => {
		const result = readLaunch(`
name: app
requires:
  - type: redis
    uses: [db, pubsub]
    set_env:
      CACHE_URL: $redis.db.url
`);
		expect(result.components.default?.requires?.[0]?.uses).toEqual(["db", "pubsub"]);
	});

	it("reads uses on a supports entry — the alias carries the field", () => {
		const result = readLaunch(`
name: app
supports:
  - type: redis
    uses: [pubsub]
`);
		expect(result.components.default?.supports?.[0]?.uses).toEqual(["pubsub"]);
	});

	it("leaves uses undefined on an entry that declares none", () => {
		const result = readLaunch(`name: app\nrequires: [redis]`);
		expect(result.components.default?.requires?.[0]).not.toHaveProperty("uses", expect.anything());
		expect(result.components.default?.requires?.[0]?.uses).toBeUndefined();
	});

	it("rejects an empty uses list — undeclared is spelled by omission", () => {
		expect(() => readLaunch(`name: app\nrequires:\n  - type: redis\n    uses: []`)).toThrow();
	});

	it("rejects a use declared twice on one entry", () => {
		expect(() =>
			readLaunch(`name: app\nrequires:\n  - type: redis\n    uses: [db, db]`),
		).toThrow(/declared once/);
	});

	it("rejects a use token outside the name grammar", () => {
		expect(() =>
			readLaunch(`name: app\nrequires:\n  - type: redis\n    uses: ["Key Space"]`),
		).toThrow(/Use tokens/);
	});

	it("accepts a use token outside the standard vocabulary — the vocabulary is open", () => {
		const result = readLaunch(`name: app\nrequires:\n  - type: redis\n    uses: [streams]`);
		expect(result.components.default?.requires?.[0]?.uses).toEqual(["streams"]);
	});

	it("reads a repeatable use named more than once, as single-key maps beside bare tokens", () => {
		const result = readLaunch(`
name: app
requires:
  - type: redis
    uses:
      - db: cache
      - db: sessions
      - pubsub
`);
		expect(result.components.default?.requires?.[0]?.uses).toEqual([
			{ db: "cache" },
			{ db: "sessions" },
			"pubsub",
		]);
	});

	it("rejects the same named use declared twice on one entry", () => {
		expect(() =>
			readLaunch(`name: app\nrequires:\n  - type: redis\n    uses: [{db: cache}, {db: cache}]`),
		).toThrow(/declared once/);
	});

	it("rejects a token declared both bare and named on one entry", () => {
		expect(() =>
			readLaunch(`name: app\nrequires:\n  - type: redis\n    uses: [db, {db: cache}]`),
		).toThrow(/both bare and named/);
	});

	it("rejects a name on a use the standard vocabulary marks non-repeatable", () => {
		expect(() =>
			readLaunch(`name: app\nrequires:\n  - type: redis\n    uses: [{pubsub: events}]`),
		).toThrow(/pubsub.* on redis is not repeatable/);
		expect(() =>
			readLaunch(`name: app\nrequires:\n  - type: postgres\n    uses: [{server: main}]`),
		).toThrow(/server.* on postgres is not repeatable/);
	});

	it("rejects a map naming two uses in one item", () => {
		expect(() =>
			readLaunch(`name: app\nrequires:\n  - type: redis\n    uses: [{db: cache, pubsub: events}]`),
		).toThrow(/single-key map/);
	});

	it("rejects a use name outside the name grammar — it is an expression path segment", () => {
		expect(() =>
			readLaunch(`name: app\nrequires:\n  - type: redis\n    uses: [{db: "Cache DB"}]`),
		).toThrow(/Names must match/);
	});

	it("accepts a named use on a token or type outside the registry — no standard says it cannot repeat", () => {
		const result = readLaunch(`
name: app
requires:
  - type: redis
    uses: [{streams: orders}]
  - type: kafka
    uses: [{topic: orders}, {topic: refunds}]
`);
		expect(result.components.default?.requires?.[0]?.uses).toEqual([{ streams: "orders" }]);
		expect(result.components.default?.requires?.[1]?.uses).toEqual([
			{ topic: "orders" },
			{ topic: "refunds" },
		]);
	});

	it("reads a provider-defined token spelled `use` as that token, named — never as a decoded value", () => {
		const result = readLaunch(`
name: app
requires:
  - type: kafka
    uses: [{use: a}, {use: b}]
`);
		expect(result.components.default?.requires?.[0]?.uses).toEqual([{ use: "a" }, { use: "b" }]);
		expect(useKeys(result.components.default?.requires?.[0]?.uses)).toEqual(["use.a", "use.b"]);
	});

	// UC-30: Build shorthand
	it("expands build string to object", () => {
		const result = readLaunch(`
name: my-app
build: .
`);
		expect(result.components.default?.build).toEqual({ context: "." });
	});

	// UC-29: Health shorthand
	it("expands health string to object", () => {
		const result = readLaunch(`
name: my-app
health: /health
`);
		expect(result.components.default?.health).toEqual({ path: "/health" });
	});

	// UC-32: depends_on shorthand
	it("expands depends_on string to object", () => {
		const result = readLaunch(`
name: my-app
depends_on: [backend]
`);
		expect(result.components.default?.depends_on).toEqual([{ component: "backend" }]);
	});

	// UC-33: Command shorthand
	it("expands command string to object", () => {
		const result = readLaunch(`
name: my-app
commands:
  start: "node server.js"
`);
		expect(result.components.default?.commands?.start).toEqual({ command: "node server.js" });
	});

	// UC-12: Native YAML types in env
	it("expands scalar env values to objects", () => {
		const result = readLaunch(`
name: my-app
env:
  PORT: 8080
  ENABLED: true
  NAME: my-app
`);
		const env = result.components.default?.env;
		expect(env?.PORT).toEqual({ default: 8080 });
		expect(env?.ENABLED).toEqual({ default: true });
		expect(env?.NAME).toEqual({ default: "my-app" });
	});

	it("reads the D-31 example field the published schema defines", () => {
		const result = readLaunch(`
name: my-app
env:
  API_KEY:
    description: The key
    example: "sk-live-abc123"
    required: true
`);
		expect(result.components.default?.env?.API_KEY).toEqual({
			description: "The key",
			example: "sk-live-abc123",
			required: true,
		});
	});

	// Multi-component
	it("reads multi-component apps", () => {
		const result = readLaunch(`
name: hedgedoc
components:
  backend:
    runtime: node
    provides:
      - protocol: http
        port: 3000
  frontend:
    runtime: node
    depends_on: [backend]
    provides:
      - protocol: http
        port: 3001
`);
		expect(Object.keys(result.components)).toEqual(["backend", "frontend"]);
		expect(result.components.backend?.provides?.[0]?.port).toBe(3000);
		expect(result.components.frontend?.depends_on).toEqual([{ component: "backend" }]);
	});

	// Multi-component inherits top-level runtime
	it("inherits top-level runtime in multi-component", () => {
		const result = readLaunch(`
name: my-app
runtime: node
components:
  api:
    provides:
      - protocol: http
        port: 3000
  worker: {}
`);
		expect(result.components.api?.runtime).toBe("node");
		expect(result.components.worker?.runtime).toBe("node");
	});

	// D-25: top-level component fields are defaults for every component that
	// omits them. Covers the 10 fields that previously had no `?? defaults?.`
	// fallback in normalizeComponent (sdk/src/reader.ts:121-141) — see #233.
	describe("D-25 inheritance — the 10 previously-dropped fields", () => {
		it("inherits top-level provides onto a component that omits it", () => {
			const result = readLaunch(`
name: my-app
provides:
  - protocol: http
    port: 3000
components:
  api: {}
`);
			expect(result.components.api?.provides).toEqual([{ protocol: "http", port: 3000 }]);
			expect(writeLaunch(result)).toContain("port: 3000");
		});

		it("inherits top-level requires onto a component that omits it", () => {
			const result = readLaunch(`
name: my-app
requires: [postgres]
components:
  api: {}
`);
			expect(result.components.api?.requires).toEqual([{ type: "postgres" }]);
			expect(writeLaunch(result)).toContain("postgres");
		});

		it("inherits top-level supports onto a component that omits it", () => {
			const result = readLaunch(`
name: my-app
supports: [redis]
components:
  api: {}
`);
			expect(result.components.api?.supports).toEqual([{ type: "redis" }]);
			expect(writeLaunch(result)).toContain("redis");
		});

		it("inherits top-level env onto a component that omits it", () => {
			const result = readLaunch(`
name: my-app
env:
  TOP: value
components:
  api: {}
`);
			expect(result.components.api?.env?.TOP).toEqual({ default: "value" });
			expect(writeLaunch(result)).toContain("TOP: value");
		});

		it("inherits top-level commands onto a component that omits it", () => {
			const result = readLaunch(`
name: my-app
commands:
  start: "node server.js"
components:
  api: {}
`);
			expect(result.components.api?.commands?.start).toEqual({ command: "node server.js" });
			expect(writeLaunch(result)).toContain("node server.js");
		});

		it("inherits top-level health onto a component that omits it", () => {
			const result = readLaunch(`
name: my-app
health: /healthz
components:
  api: {}
`);
			expect(result.components.api?.health).toEqual({ path: "/healthz" });
			expect(writeLaunch(result)).toContain("/healthz");
		});

		it("inherits top-level depends_on onto a component that omits it", () => {
			const result = readLaunch(`
name: my-app
depends_on: [backend]
components:
  api: {}
`);
			expect(result.components.api?.depends_on).toEqual([{ component: "backend" }]);
			expect(writeLaunch(result)).toContain("backend");
		});

		it("inherits top-level storage onto a component that omits it", () => {
			const result = readLaunch(`
name: my-app
storage:
  data:
    path: /data
components:
  api: {}
`);
			expect(result.components.api?.storage?.data).toEqual({ path: "/data" });
			expect(writeLaunch(result)).toContain("/data");
		});

		it("inherits top-level schedule onto a component that omits it", () => {
			const result = readLaunch(`
name: my-app
schedule: "0 0 * * *"
components:
  api: {}
`);
			expect(result.components.api?.schedule).toBe("0 0 * * *");
			expect(writeLaunch(result)).toContain("0 0 * * *");
		});

		it("inherits top-level singleton onto a component that omits it", () => {
			const result = readLaunch(`
name: my-app
singleton: true
components:
  api: {}
`);
			expect(result.components.api?.singleton).toBe(true);
			expect(writeLaunch(result)).toContain("singleton: true");
		});

		// D-25 is whole-value replacement, not a deep merge (see ADR): a
		// component that declares its own value takes it entirely and inherits
		// none of the top-level value, even an empty one.
		it("does not merge — a component's own env blocks inheritance entirely", () => {
			const result = readLaunch(`
name: my-app
env:
  TOP: value
components:
  api:
    env:
      OWN: mine
`);
			expect(result.components.api?.env).toEqual({ OWN: { default: "mine" } });
			expect(result.components.api?.env?.TOP).toBeUndefined();
		});

		it("does not merge — an explicit empty env blocks inheritance rather than falling back", () => {
			const result = readLaunch(`
name: my-app
env:
  TOP: value
components:
  api:
    env: {}
`);
			// api declares env at all (even empty), so it takes its own value
			// whole — {} is not nullish, so it must not fall back to defaults.
			expect(result.components.api?.env).toEqual({});
		});

		// sdk/src/reader.ts:91 passes no defaults in single-component mode —
		// confirm none of the 10 fields regressed there.
		it("leaves single-component mode unaffected", () => {
			const result = readLaunch(`
name: my-app
provides:
  - protocol: http
    port: 8080
requires: [postgres]
env:
  PORT: 8080
storage:
  data:
    path: /data
singleton: true
`);
			expect(result.components.default?.provides).toEqual([{ protocol: "http", port: 8080 }]);
			expect(result.components.default?.requires).toEqual([{ type: "postgres" }]);
			expect(result.components.default?.env?.PORT).toEqual({ default: 8080 });
			expect(result.components.default?.storage?.data).toEqual({ path: "/data" });
			expect(result.components.default?.singleton).toBe(true);
		});
	});

	// UC-36: Health with start_period
	it("reads health with start_period", () => {
		const result = readLaunch(`
name: my-app
health:
  path: /healthz
  interval: 30s
  start_period: 60s
`);
		expect(result.components.default?.health?.start_period).toBe("60s");
	});

	// UC-40: Build target
	it("reads build target", () => {
		const result = readLaunch(`
name: my-app
build:
  dockerfile: Dockerfile
  target: production
`);
		expect(result.components.default?.build?.target).toBe("production");
	});

	// UC-43: Singleton
	it("reads singleton flag", () => {
		const result = readLaunch(`
name: scheduler
singleton: true
commands:
  start: "celery beat"
`);
		expect(result.components.default?.singleton).toBe(true);
	});

	// UC-42: Schedule
	it("reads schedule", () => {
		const result = readLaunch(`
name: daily-sync
schedule: "0 0 * * *"
restart: "no"
commands:
  start: "node sync.js"
`);
		expect(result.components.default?.schedule).toBe("0 0 * * *");
		expect(result.components.default?.restart).toBe("no");
	});

	// UC-35: Storage
	it("reads storage volumes", () => {
		const result = readLaunch(`
name: my-app
storage:
  uploads:
    path: /app/uploads
    persistent: true
  cache:
    path: /tmp/cache
    persistent: false
`);
		expect(result.components.default?.storage?.uploads).toEqual({
			path: "/app/uploads",
			persistent: true,
		});
	});

	it("reads the D-30 size hint the published schema defines", () => {
		const result = readLaunch(`
name: my-app
storage:
  data:
    path: /data
    size: 10GB
    persistent: true
`);
		expect(result.components.default?.storage?.data).toEqual({
			path: "/data",
			size: "10GB",
			persistent: true,
		});
	});

	it("carries the size hint through parse → serialize", () => {
		const yaml = `version: launch/v1
name: my-app
image: nginx
storage:
  data:
    path: /data
    size: 512MB
`;
		expect(writeLaunch(readLaunch(yaml))).toContain("size: 512MB");
	});

	it("reads the D-50 content: operator marker", () => {
		const result = readLaunch(`
name: media-server
image: navidrome:latest
storage:
  data:
    path: /data
    persistent: true
  music:
    path: /music
    content: operator
`);
		expect(result.components.default?.storage?.music).toEqual({
			path: "/music",
			content: "operator",
		});
		// The sibling provider-owned volume carries no marker.
		expect(result.components.default?.storage?.data?.content).toBeUndefined();
	});

	it("rejects a content value other than operator", () => {
		expect(() =>
			readLaunch(`
name: media-server
image: navidrome:latest
storage:
  music:
    path: /music
    content: user
`),
		).toThrow();
	});

	it("carries content: operator through parse → serialize", () => {
		const yaml = `version: launch/v1
name: media-server
image: navidrome:latest
storage:
  music:
    path: /music
    content: operator
`;
		expect(writeLaunch(readLaunch(yaml))).toContain("content: operator");
	});

	// Secrets
	it("reads secrets block and passes to normalized output", () => {
		const result = readLaunch(`
name: chatwoot
secrets:
  secret-key-base:
    generator: secret
  jwt-secret:
    generator: uuid
    description: "JWT signing key"
components:
  web:
    env:
      SECRET_KEY_BASE: "$secrets.secret-key-base"
  sidekiq:
    env:
      SECRET_KEY_BASE: "$secrets.secret-key-base"
`);
		expect(result.secrets).toEqual({
			"secret-key-base": { generator: "secret" },
			"jwt-secret": { generator: "uuid", description: "JWT signing key" },
		});
		expect(result.components.web?.env?.SECRET_KEY_BASE).toEqual({
			default: "$secrets.secret-key-base",
		});
		expect(result.components.sidekiq?.env?.SECRET_KEY_BASE).toEqual({
			default: "$secrets.secret-key-base",
		});
	});

	// UDP protocol
	it("reads UDP provides", () => {
		const result = readLaunch(`
name: pihole
provides:
  - protocol: udp
    port: 53
  - protocol: tcp
    port: 53
  - protocol: http
    port: 80
    exposed: true
`);
		expect(result.components.default?.provides?.[0]?.protocol).toBe("udp");
		expect(result.components.default?.provides?.length).toBe(3);
	});

	// Validation errors
	it("throws on missing name", () => {
		expect(() => readLaunch(`runtime: node`)).toThrow();
	});

	it("throws on invalid runtime", () => {
		expect(() => readLaunch(`name: app\nruntime: cobol`)).toThrow();
	});
});

/*---
req: REQ-401
type: unit
status: implemented
area: launch-spec
summary: Serializes LaunchApp back to compact YAML with shorthand collapse
rationale: |
  The writer produces human-readable YAML by collapsing objects back to
  string shorthands where possible (e.g. build with only context becomes
  a string). This keeps generated Launchfile files clean and idiomatic.
acceptance:
  - Roundtrips a minimal app through read → write
  - Collapses build/health/requires/command/depends_on/env to string when only one field
  - Keeps build as object when target is set
  - Roundtrips multi-component apps
tags: [launch-spec, writer, core]
source:
  type: implementation
  ref: implementation-discovery
changed:
  - date: 2026-03-28
    note: Backfilled by surface backfill
---*/
describe("writeLaunch", () => {
	// Roundtrip: read → write → read
	it("roundtrips a minimal app", () => {
		const original = readLaunch(`
version: launch/v1
name: my-api
runtime: node
commands:
  start: "node server.js"
`);
		const yaml = writeLaunch(original);
		const roundtripped = readLaunch(yaml);
		expect(roundtripped).toEqual(original);
	});

	// Collapses shorthands
	it("collapses build to string when only context", () => {
		const launch = readLaunch(`name: my-app\nbuild: .`);
		const yaml = writeLaunch(launch);
		expect(yaml).toContain("build: .");
	});

	it("collapses health to string when only path", () => {
		const launch = readLaunch(`name: my-app\nhealth: /health`);
		const yaml = writeLaunch(launch);
		expect(yaml).toContain("health: /health");
	});

	it("collapses requires to string when only type", () => {
		const launch = readLaunch(`name: my-app\nrequires: [postgres]`);
		const yaml = writeLaunch(launch);
		expect(yaml).toContain("postgres");
	});

	it("keeps a requires entry as an object when only type and uses are set", () => {
		// Without the guard, `type` + `uses` would collapse to the bare string
		// `redis` and the declaration would vanish through parse → serialize.
		const launch = readLaunch(`name: my-app\nrequires:\n  - type: redis\n    uses: [db]`);
		const yaml = writeLaunch(launch);
		expect(yaml).toContain("type: redis");
		expect(yaml).toMatch(/uses:\n\s+- db/);
		expect(readLaunch(yaml).components.default?.requires?.[0]?.uses).toEqual(["db"]);
	});

	it("carries uses through parse → serialize beside the other fields", () => {
		const yaml = `version: launch/v1
name: my-app
requires:
  - type: redis
    name: cache
    uses:
      - db
      - pubsub
    set_env:
      CACHE_URL: $cache.db.url
`;
		const round = writeLaunch(readLaunch(yaml));
		expect(readLaunch(round).components.default?.requires?.[0]).toEqual(
			readLaunch(yaml).components.default?.requires?.[0],
		);
		expect(round).toContain("- pubsub");
	});

	it("round-trips the named map form — `- db: cache` survives parse → serialize → parse", () => {
		const yaml = `version: launch/v1
name: my-app
requires:
  - type: redis
    uses:
      - db: cache
      - db: sessions
      - pubsub
    set_env:
      CACHE_URL: $redis.db.cache.url
      SESSIONS_DB: $redis.db.sessions.index
`;
		const round = writeLaunch(readLaunch(yaml));
		expect(round).toMatch(/uses:\n\s+- db: cache\n\s+- db: sessions\n\s+- pubsub/);
		expect(readLaunch(round).components.default?.requires?.[0]?.uses).toEqual([
			{ db: "cache" },
			{ db: "sessions" },
			"pubsub",
		]);
	});

	it("collapses command to string when no timeout", () => {
		const launch = readLaunch(`name: my-app\ncommands:\n  start: "node server.js"`);
		const yaml = writeLaunch(launch);
		expect(yaml).toContain("start: node server.js");
	});

	it("collapses depends_on to string when no condition", () => {
		const launch = readLaunch(`name: my-app\ndepends_on: [backend]`);
		const yaml = writeLaunch(launch);
		expect(yaml).toContain("backend");
	});

	it("collapses env to scalar when only default", () => {
		const launch = readLaunch(`name: my-app\nenv:\n  PORT: "8080"`);
		const yaml = writeLaunch(launch);
		expect(yaml).toContain("PORT: \"8080\"");
	});

	it("carries the D-31 example field through parse → serialize", () => {
		const yaml = `version: launch/v1
name: my-app
runtime: node
env:
  API_KEY:
    default: "sk-live-default"
    example: "sk-live-abc123"
`;
		expect(writeLaunch(readLaunch(yaml))).toContain("example: sk-live-abc123");
	});

	// Keeps object form when extra fields present
	it("keeps build as object when target is set", () => {
		const launch = readLaunch(`
name: my-app
build:
  dockerfile: Dockerfile
  target: production
`);
		const yaml = writeLaunch(launch);
		expect(yaml).toContain("target: production");
		expect(yaml).toContain("dockerfile: Dockerfile");
	});

	// Roundtrip multi-component
	it("roundtrips a multi-component app", () => {
		const original = readLaunch(`
name: hedgedoc
components:
  backend:
    runtime: node
    provides:
      - protocol: http
        port: 3000
    requires:
      - type: postgres
        version: ">=15"
        set_env:
          DATABASE_URL: $url
  frontend:
    runtime: node
    depends_on: [backend]
`);
		const yaml = writeLaunch(original);
		const roundtripped = readLaunch(yaml);
		expect(roundtripped).toEqual(original);
	});
});

/*---
req: REQ-415
type: unit
status: implemented
area: launch-spec
summary: Reads and writes commands.*.capture (D-34) for any lifecycle stage
rationale: |
  D-34 moves capture from the top-level `outputs:` field into a nested
  `capture:` field on any command that uses the expanded form. The reader
  normalization must preserve capture through to NormalizedCommand, and
  the writer must emit the expanded command form whenever capture is
  present (not collapse to the string shorthand). This also covers the
  new `commands.bootstrap` lifecycle stage, which exists precisely to host
  post-start setup commands that capture output like invite links.
acceptance:
  - Reader parses a nested capture block on commands.bootstrap
  - Reader parses a nested capture block on commands.release
  - Reader preserves the expanded command form when both timeout and
    capture are present
  - Writer emits the expanded form whenever capture is present, even
    when timeout is absent
  - Round-trip (read → write → read) preserves capture content
  - Commands without capture still collapse to the string shorthand
tags: [launch-spec, reader, writer, commands, d-34]
---*/
describe("commands.*.capture (D-34)", () => {
	it("reads nested capture on commands.bootstrap", () => {
		const result = readLaunch(`
version: launch/v1
name: concentrator
runtime: bun
commands:
  start: "bun run start"
  bootstrap:
    command: "concentrator-cli create-invite --name admin --url $app.url"
    capture:
      invite_link:
        pattern: "https?://\\\\S+"
        description: "One-time invite link"
        sensitive: true
`);
		expect(result.components.default?.commands?.bootstrap).toEqual({
			command: "concentrator-cli create-invite --name admin --url $app.url",
			capture: {
				invite_link: {
					pattern: "https?://\\S+",
					description: "One-time invite link",
					sensitive: true,
				},
			},
		});
	});

	it("reads nested capture on commands.release (the old outputs use case)", () => {
		const result = readLaunch(`
version: launch/v1
name: example
runtime: node
commands:
  release:
    command: "./setup.sh"
    capture:
      admin_password:
        pattern: "Admin password: (.+)"
        description: "Generated admin password"
        sensitive: true
      admin_url:
        pattern: "Dashboard: (https?://\\\\S+)"
`);
		const release = result.components.default?.commands?.release;
		expect(release?.command).toBe("./setup.sh");
		expect(release?.capture?.admin_password).toEqual({
			pattern: "Admin password: (.+)",
			description: "Generated admin password",
			sensitive: true,
		});
		expect(release?.capture?.admin_url).toEqual({
			pattern: "Dashboard: (https?://\\S+)",
		});
	});

	it("preserves timeout and capture together in the expanded form", () => {
		const result = readLaunch(`
version: launch/v1
name: example
runtime: node
commands:
  release:
    command: "./setup.sh"
    timeout: "5m"
    capture:
      token:
        pattern: "token=(\\\\S+)"
`);
		expect(result.components.default?.commands?.release).toEqual({
			command: "./setup.sh",
			timeout: "5m",
			capture: {
				token: { pattern: "token=(\\S+)" },
			},
		});
	});

	it("writer emits expanded form when capture is set (even without timeout)", () => {
		const original = readLaunch(`
version: launch/v1
name: example
runtime: node
commands:
  bootstrap:
    command: "my-cli init --url $app.url"
    capture:
      link:
        pattern: "https?://\\\\S+"
        sensitive: true
`);
		const yaml = writeLaunch(original);
		// Must NOT collapse to the string shorthand
		expect(yaml).not.toMatch(/bootstrap:\s*"my-cli/);
		// Must keep capture visible in the output
		expect(yaml).toContain("capture:");
		expect(yaml).toContain("link:");
		expect(yaml).toContain("sensitive: true");
	});

	it("writer still collapses to string shorthand for capture-less commands", () => {
		const original = readLaunch(`
version: launch/v1
name: example
runtime: node
commands:
  start: "node server.js"
  release: "npx prisma migrate deploy"
`);
		const yaml = writeLaunch(original);
		// Both should collapse to string form — no `command:` key introduced.
		// Match the value only (YAML library chooses its own quoting style).
		expect(yaml).toMatch(/start:\s*["']?node server\.js["']?/);
		expect(yaml).toMatch(/release:\s*["']?npx prisma migrate deploy["']?/);
		// And critically, no expanded-form artifacts
		expect(yaml).not.toMatch(/start:\s*\n\s+command:/);
		expect(yaml).not.toMatch(/release:\s*\n\s+command:/);
	});

	it("round-trips a Launchfile with commands.bootstrap + capture", () => {
		const original = readLaunch(`
version: launch/v1
name: concentrator
runtime: bun
env:
  ORIGIN:
    default: $app.url
commands:
  start: "bun run start"
  bootstrap:
    command: "concentrator-cli create-invite --name admin --url $app.url"
    capture:
      invite_link:
        pattern: "https?://\\\\S+"
        description: "One-time invite link"
        sensitive: true
`);
		const yaml = writeLaunch(original);
		const roundtripped = readLaunch(yaml);
		expect(roundtripped).toEqual(original);
	});

	it("rejects invalid regex patterns inside nested capture", () => {
		expect(() =>
			readLaunch(`
version: launch/v1
name: example
runtime: node
commands:
  bootstrap:
    command: "my-cli init"
    capture:
      bad:
        pattern: "(unclosed"
`),
		).toThrow();
	});
});

describe("source-mode commands (D-38)", () => {
	it("normalizes the install and dev command keys and the source field", () => {
		const launch = readLaunch(`
name: devapp
source: ./apps/api
commands:
  build: "docker build ."
  install: "bun install"
  start: "node dist/server.js"
  dev: "bun run dev"
`);
		const component = launch.components.default!;
		expect(component.source).toBe("./apps/api");
		const commands = component.commands!;
		expect(commands.install).toEqual({ command: "bun install" });
		expect(commands.dev).toEqual({ command: "bun run dev" });
		// release/bootstrap/seed/test are mode-invariant — no dev:<stage> variants
		expect(commands["dev:build"]).toBeUndefined();
	});

	it("round-trips install/dev and source through write", () => {
		const out = writeLaunch(
			readLaunch(`
name: devapp
source: ./apps/api
commands:
  install: "bun install"
  dev: "bun run dev"
`),
		);
		expect(out).toContain("install: bun install");
		expect(out).toContain("dev: bun run dev");
		expect(out).toContain("source: ./apps/api");
	});
});

describe("legacy host block round-trip (D-54 anti-normalization guard)", () => {
	// D-54 rejected parse-time normalization: a normalizing parse would make
	// readLaunch → writeLaunch silently migrate the user's source file. The
	// deprecation is a report, never a rewrite — so the block must survive the
	// round-trip as a block, with every key and value intact.
	const LEGACY = `version: launch/v1
name: legacy
image: app:1
host:
  docker: required
  network: host
  filesystem: read-write
  privileged: true
`;

	it("writes the host block back as a block, not as capability entries", () => {
		const out = writeLaunch(readLaunch(LEGACY));
		expect(out).toContain("host:");
		expect(out).toContain("docker: required");
		expect(out).not.toContain("container_runtime");
		expect(out).not.toContain("requires:");
		expect(out).not.toContain("supports:");
	});

	it("is stable across a second round-trip, key for key", () => {
		const once = writeLaunch(readLaunch(LEGACY));
		expect(writeLaunch(readLaunch(once))).toBe(once);
		expect(readLaunch(once).components.default!.host).toEqual({
			docker: "required",
			network: "host",
			filesystem: "read-write",
			privileged: true,
		});
	});

	it("does not add a host block to a file that has none", () => {
		const out = writeLaunch(
			readLaunch("name: modern\nimage: app:1\nrequires:\n  - host: { network: host }\n"),
		);
		expect(out).not.toMatch(/^host:/m);
	});
});
