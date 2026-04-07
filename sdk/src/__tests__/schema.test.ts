import { describe, it, expect } from "vitest";
import { LaunchSchema, NameSchema } from "../schema.js";

/*---
req: REQ-420
type: unit
status: implemented
area: launch-spec
summary: Validates Launchfile app and component names
rationale: |
  Names become Docker container names, DNS labels, and database identifiers.
  They must be safe for all these contexts — no dots, no leading digits or
  hyphens, no empty strings.
acceptance:
  - Accepts valid names (lowercase, hyphens, digits after first char)
  - Rejects names starting with digit or hyphen
  - Rejects names with dots
  - Rejects empty string
tags: [launch-spec, schema, validation]
source:
  type: implementation
  ref: implementation-discovery
changed:
  - date: 2026-03-28
    note: Backfilled by surface backfill
---*/
describe("NameSchema", () => {
	it("accepts valid names", () => {
		expect(() => NameSchema.parse("my-app")).not.toThrow();
		expect(() => NameSchema.parse("backend")).not.toThrow();
		expect(() => NameSchema.parse("api-v2")).not.toThrow();
		expect(() => NameSchema.parse("a")).not.toThrow();
	});

	it("rejects names starting with digit", () => {
		expect(() => NameSchema.parse("2app")).toThrow();
	});

	it("rejects names starting with hyphen", () => {
		expect(() => NameSchema.parse("-app")).toThrow();
	});

	it("rejects names with dots", () => {
		expect(() => NameSchema.parse("my.app")).toThrow();
	});

	it("rejects empty string", () => {
		expect(() => NameSchema.parse("")).toThrow();
	});
});

/*---
req: REQ-421
type: unit
status: implemented
area: launch-spec
summary: Validates the full Launchfile Zod schema including all field types
rationale: |
  The schema is the contract between app authors and platforms. It must
  accept all valid Launchfile patterns (shorthands, multi-component,
  env generators, health checks, storage, secrets, UDP, platform constraints)
  and reject malformed input with clear errors.
acceptance:
  - Validates minimal app with name + provides
  - Validates requires as string array and object array, with set_env
  - Accepts integer/boolean/float env defaults, generators, sensitive flag
  - Accepts build as string and object (with target, secrets)
  - Accepts health as string and object (with start_period, command)
  - Accepts depends_on, commands, restart, schedule, singleton, image
  - Accepts storage volumes, platform constraint, version
  - Validates named provides, bind, spec, label, version on requires
  - Validates multi-component apps and UDP protocol
  - Accepts top-level secrets block
  - Rejects missing name, invalid runtime, invalid port
tags: [launch-spec, schema, validation, core]
source:
  type: implementation
  ref: implementation-discovery
changed:
  - date: 2026-03-28
    note: Backfilled by surface backfill
---*/
describe("LaunchSchema", () => {
	// UC-1: Minimal 3-line app
	it("validates a minimal app", () => {
		const result = LaunchSchema.parse({
			name: "my-api",
			runtime: "node",
			commands: { start: "node server.js" },
		});
		expect(result.name).toBe("my-api");
		expect(result.runtime).toBe("node");
	});

	// UC-24: Minimal app with database shorthand
	it("validates requires as string array shorthand", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			runtime: "node",
			requires: ["postgres"],
			commands: { start: "node server.js" },
		});
		expect(result.requires).toEqual(["postgres"]);
	});

	// UC-2: App with required database (full form)
	it("validates requires as object array", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			requires: [{ type: "postgres", set_env: { DATABASE_URL: "$url" } }],
		});
		expect(result.requires?.[0]).toEqual({ type: "postgres", set_env: { DATABASE_URL: "$url" } });
	});

	// UC-7: Optional resource with supports
	it("validates supports with set_env", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			supports: [{ type: "redis", set_env: { CACHE_URL: "$url", USE_CACHE: "1" } }],
		});
		expect(result.supports?.[0]).toEqual({
			type: "redis",
			set_env: { CACHE_URL: "$url", USE_CACHE: "1" },
		});
	});

	// UC-12: Native YAML types in env
	it("accepts integer, boolean, float in env defaults", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			env: {
				PORT: 8080,
				ENABLED: true,
				RATE: 0.5,
			},
		});
		expect(result.env?.PORT).toBe(8080);
		expect(result.env?.ENABLED).toBe(true);
		expect(result.env?.RATE).toBe(0.5);
	});

	// UC-14: Auto-generated secrets
	it("validates generator field", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			env: {
				SECRET: { generator: "secret" },
				ID: { generator: "uuid" },
			},
		});
		const secret = result.env?.SECRET as { generator: string };
		expect(secret.generator).toBe("secret");
	});

	// UC-28: Sensitive env vars
	it("validates sensitive field", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			env: {
				API_KEY: { required: true, sensitive: true },
			},
		});
		const key = result.env?.API_KEY as { sensitive: boolean };
		expect(key.sensitive).toBe(true);
	});

	// UC-30: Build shorthand
	it("accepts build as string shorthand", () => {
		const result = LaunchSchema.parse({ name: "my-app", build: "." });
		expect(result.build).toBe(".");
	});

	// UC-40: Build target
	it("accepts build with target", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			build: { dockerfile: "Dockerfile", target: "production" },
		});
		const build = result.build as { target: string };
		expect(build.target).toBe("production");
	});

	// UC-41: Build secrets
	it("accepts build secrets", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			build: { dockerfile: "Dockerfile", secrets: ["NPM_TOKEN"] },
		});
		const build = result.build as { secrets: string[] };
		expect(build.secrets).toEqual(["NPM_TOKEN"]);
	});

	// UC-29: Health shorthand
	it("accepts health as string shorthand", () => {
		const result = LaunchSchema.parse({ name: "my-app", health: "/health" });
		expect(result.health).toBe("/health");
	});

	// UC-36: Health with start_period
	it("accepts health with start_period", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			health: { path: "/healthz", start_period: "60s" },
		});
		const health = result.health as { start_period: string };
		expect(health.start_period).toBe("60s");
	});

	// UC-37: Non-HTTP health check
	it("accepts health with command", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			health: { command: "pg_isready -U postgres" },
		});
		const health = result.health as { command: string };
		expect(health.command).toBe("pg_isready -U postgres");
	});

	// UC-32: depends_on shorthand
	it("accepts depends_on as string array", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			depends_on: ["backend", "worker"],
		});
		expect(result.depends_on).toEqual(["backend", "worker"]);
	});

	// UC-26: depends_on with condition
	it("accepts depends_on with health condition", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			depends_on: [{ component: "backend", condition: "healthy" }],
		});
		const dep = result.depends_on?.[0] as { condition: string };
		expect(dep.condition).toBe("healthy");
	});

	// UC-33: Command shorthand
	it("accepts commands as strings", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			commands: { start: "node server.js", build: "npm install" },
		});
		expect(result.commands?.start).toBe("node server.js");
	});

	// UC-33: Command with timeout
	it("accepts commands as objects with timeout", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			commands: { start: { command: "node server.js", timeout: "60s" } },
		});
		const start = result.commands?.start as { command: string; timeout: string };
		expect(start.timeout).toBe("60s");
	});

	// UC-38: Restart policy
	it("accepts restart policy", () => {
		const result = LaunchSchema.parse({ name: "my-app", restart: "on-failure" });
		expect(result.restart).toBe("on-failure");
	});

	// UC-42: Schedule
	it("accepts schedule for cron jobs", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			schedule: "0 0 * * *",
		});
		expect(result.schedule).toBe("0 0 * * *");
	});

	// UC-43: Singleton
	it("accepts singleton flag", () => {
		const result = LaunchSchema.parse({ name: "my-app", singleton: true });
		expect(result.singleton).toBe(true);
	});

	// UC-34: Pre-built image
	it("accepts image field", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			image: "ghcr.io/org/app:v2",
		});
		expect(result.image).toBe("ghcr.io/org/app:v2");
	});

	// UC-35: Storage
	it("accepts storage volumes", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			storage: {
				uploads: { path: "/app/uploads", persistent: true },
			},
		});
		expect(result.storage?.uploads).toEqual({ path: "/app/uploads", persistent: true });
	});

	// UC-39: Platform
	it("accepts platform constraint", () => {
		const result = LaunchSchema.parse({ name: "my-app", platform: "linux/amd64" });
		expect(result.platform).toBe("linux/amd64");
	});

	// UC-27: version header
	it("accepts version", () => {
		const result = LaunchSchema.parse({
			version: "launch/v1",
			name: "my-app",
		});
		expect(result.version).toBe("launch/v1");
	});

	// UC-10: Named endpoints
	it("validates named provides endpoints", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			provides: [
				{ name: "api", protocol: "http", port: 3000 },
				{ name: "metrics", protocol: "http", port: 9090 },
			],
		});
		expect(result.provides?.[0]).toEqual({ name: "api", protocol: "http", port: 3000 });
		expect(result.provides?.[1]).toEqual({ name: "metrics", protocol: "http", port: 9090 });
	});

	// UC-15: Bind address
	it("accepts bind on provides", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			provides: [{ protocol: "http", port: 3000, bind: "0.0.0.0" }],
		});
		expect(result.provides?.[0]?.bind).toBe("0.0.0.0");
	});

	// UC-16: Spec reference
	it("accepts spec on provides", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			provides: [{
				protocol: "http",
				port: 3000,
				spec: { openapi: "file:docs/openapi.yaml" },
			}],
		});
		expect(result.provides?.[0]?.spec?.openapi).toBe("file:docs/openapi.yaml");
	});

	// UC-44: Label on env vars
	it("accepts label on env vars", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			env: {
				API_KEY: { required: true, label: "Stripe API Key" },
			},
		});
		const key = result.env?.API_KEY as { label: string };
		expect(key.label).toBe("Stripe API Key");
	});

	// UC-22: Version constraints
	it("accepts version on requires", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			requires: [{ type: "postgres", version: ">=15" }],
		});
		const req = result.requires?.[0] as { version: string };
		expect(req.version).toBe(">=15");
	});

	// Multi-component
	it("validates multi-component apps", () => {
		const result = LaunchSchema.parse({
			name: "hedgedoc",
			components: {
				backend: {
					runtime: "node",
					provides: [{ protocol: "http", port: 3000 }],
				},
				frontend: {
					runtime: "node",
					depends_on: ["backend"],
				},
			},
		});
		expect(Object.keys(result.components!)).toEqual(["backend", "frontend"]);
	});

	// UDP protocol
	it("accepts UDP protocol on provides", () => {
		const result = LaunchSchema.parse({
			name: "pihole",
			provides: [
				{ protocol: "http", port: 80 },
				{ protocol: "udp", port: 53 },
				{ protocol: "tcp", port: 53 },
			],
		});
		expect(result.provides?.[1]?.protocol).toBe("udp");
	});

	// Secrets block
	it("accepts top-level secrets block", () => {
		const result = LaunchSchema.parse({
			name: "my-app",
			secrets: {
				"jwt-secret": { generator: "secret" },
				"api-key": { generator: "uuid", description: "Internal API key" },
			},
		});
		expect(result.secrets?.["jwt-secret"]).toEqual({ generator: "secret" });
		expect(result.secrets?.["api-key"]?.description).toBe("Internal API key");
	});

	it("accepts secrets with multi-component app", () => {
		const result = LaunchSchema.parse({
			name: "chatwoot",
			secrets: {
				"secret-key-base": { generator: "secret" },
			},
			components: {
				web: {
					env: { SECRET_KEY_BASE: "$secrets.secret-key-base" },
				},
				sidekiq: {
					env: { SECRET_KEY_BASE: "$secrets.secret-key-base" },
				},
			},
		});
		expect(result.secrets?.["secret-key-base"]).toBeDefined();
		expect(Object.keys(result.components!)).toEqual(["web", "sidekiq"]);
	});

	// Reject invalid
	it("rejects missing name", () => {
		expect(() => LaunchSchema.parse({ runtime: "node" })).toThrow();
	});

	it("rejects invalid runtime", () => {
		expect(() => LaunchSchema.parse({ name: "app", runtime: "cobol" })).toThrow();
	});

	it("rejects invalid port", () => {
		expect(() =>
			LaunchSchema.parse({
				name: "app",
				provides: [{ protocol: "http", port: 99999 }],
			}),
		).toThrow();
	});
});
