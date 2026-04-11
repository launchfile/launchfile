import { describe, it, expect } from "vitest";
import { readLaunch } from "../reader.js";
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
  multi-component apps with runtime inheritance.
acceptance:
  - Reads a minimal 3-line app
  - Expands requires/build/health/depends_on/command string shorthands to objects
  - Expands scalar env values to objects
  - Reads multi-component apps with runtime inheritance
  - Reads health with start_period, build target, singleton, schedule, storage, secrets, UDP
  - Throws on missing name or invalid runtime
tags: [launch-spec, reader, core]
source:
  type: implementation
  ref: implementation-discovery
changed:
  - date: 2026-03-28
    note: Backfilled by surface backfill
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
