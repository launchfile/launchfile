import { describe, it, expect } from "vitest";
import { parseExpression, resolveExpression, parseDotPath, isExpression } from "../resolver.js";

/*---
req: REQ-410
type: unit
status: implemented
area: launch-spec
summary: Detects $-prefixed expression strings in Launchfile values
rationale: |
  Expression detection gates the resolver pipeline — only values containing
  $references need parsing and resolution. Must distinguish real refs ($prop)
  from escaped literals ($$).
acceptance:
  - Returns true for $prop and ${prop} syntax
  - Returns false for plain literals and numbers
  - Returns false for $$ (escaped dollar)
  - Returns true for mixed $$ and $ strings
tags: [launch-spec, resolver]
source:
  type: implementation
  ref: implementation-discovery
changed:
  - date: 2026-03-28
    note: Backfilled by surface backfill
---*/
describe("isExpression", () => {
	it("returns true for $prop", () => {
		expect(isExpression("$url")).toBe(true);
	});

	it("returns true for ${prop}", () => {
		expect(isExpression("${url}")).toBe(true);
	});

	it("returns false for literals", () => {
		expect(isExpression("postgresql")).toBe(false);
		expect(isExpression("1")).toBe(false);
		expect(isExpression("")).toBe(false);
	});

	// UC-17: $$ is not an expression
	it("returns false for $$ (escaped dollar)", () => {
		expect(isExpression("$$HOME")).toBe(false);
	});

	it("returns true for mixed $$ and $", () => {
		expect(isExpression("$$HOME/$path")).toBe(true);
	});
});

/*---
req: REQ-411
type: unit
status: implemented
area: launch-spec
summary: Parses dot-separated property paths for cross-component references
rationale: |
  Dot paths like $components.backend.url let apps reference each other's
  endpoints. The parser must handle simple props, dotted paths, component
  paths, named endpoints, and bracket notation.
acceptance:
  - Parses simple property, dotted path, component path, named endpoint path
  - Parses bracket notation
tags: [launch-spec, resolver]
source:
  type: implementation
  ref: implementation-discovery
changed:
  - date: 2026-03-28
    note: Backfilled by surface backfill
---*/
describe("parseDotPath", () => {
	it("parses simple property", () => {
		expect(parseDotPath("url")).toEqual(["url"]);
	});

	it("parses dotted path", () => {
		expect(parseDotPath("postgres.host")).toEqual(["postgres", "host"]);
	});

	it("parses component path", () => {
		expect(parseDotPath("components.backend.url")).toEqual(["components", "backend", "url"]);
	});

	// UC-10: Named endpoint path
	it("parses named endpoint path", () => {
		expect(parseDotPath("components.backend.metrics.url")).toEqual([
			"components", "backend", "metrics", "url",
		]);
	});

	// Bracket notation for instances
	it("parses bracket notation", () => {
		expect(parseDotPath("components.backend.instances[0].host")).toEqual([
			"components", "backend", "instances", "0", "host",
		]);
	});
});

/*---
req: REQ-412
type: unit
status: implemented
area: launch-spec
summary: Parses $-expressions into typed AST nodes (reference, literal, template)
rationale: |
  Expression parsing is the core of Launchfile's variable system. It turns
  strings like "postgresql://$user:$password@$postgres.host:${port:-5432}/$name"
  into structured ASTs that the resolver can evaluate against a deployment context.
acceptance:
  - Parses $url and $postgres.host as references
  - Parses $components.backend.url as component reference
  - Parses ${port:-5432} with fallback
  - Parses literals (no $) and numbers
  - Parses $$ as literal $
  - Parses composed templates with multiple refs
  - Simplifies single-ref templates to plain references
tags: [launch-spec, resolver, core]
source:
  type: implementation
  ref: implementation-discovery
changed:
  - date: 2026-03-28
    note: Backfilled by surface backfill
---*/
describe("parseExpression", () => {
	// UC-2: Simple property reference
	it("parses $url as reference", () => {
		const result = parseExpression("$url");
		expect(result).toEqual({ kind: "reference", path: ["url"] });
	});

	// UC-9: Cross-resource reference
	it("parses $postgres.host as reference", () => {
		const result = parseExpression("$postgres.host");
		expect(result).toEqual({ kind: "reference", path: ["postgres", "host"] });
	});

	// Cross-component reference
	it("parses $components.backend.url", () => {
		const result = parseExpression("$components.backend.url");
		expect(result).toEqual({
			kind: "reference",
			path: ["components", "backend", "url"],
		});
	});

	// UC-6: Defaults
	it("parses ${port:-5432} with fallback", () => {
		const result = parseExpression("${port:-5432}");
		expect(result).toEqual({
			kind: "reference",
			path: ["port"],
			fallback: "5432",
		});
	});

	// UC-4: Literal values
	it("parses literal string (no $)", () => {
		const result = parseExpression("postgresql");
		expect(result).toEqual({ kind: "literal", value: "postgresql" });
	});

	it("parses literal number string", () => {
		const result = parseExpression("1");
		expect(result).toEqual({ kind: "literal", value: "1" });
	});

	// UC-17: Dollar escape
	it("parses $$ as literal $", () => {
		const result = parseExpression("$$HOME");
		expect(result).toEqual({ kind: "literal", value: "$HOME" });
	});

	// UC-5: Composed template
	it("parses composed template", () => {
		const result = parseExpression("jdbc:postgresql://${host}:${port}/${name}");
		expect(result.kind).toBe("template");
		if (result.kind === "template") {
			expect(result.parts).toEqual([
				{ kind: "text", value: "jdbc:postgresql://" },
				{ kind: "ref", path: ["host"] },
				{ kind: "text", value: ":" },
				{ kind: "ref", path: ["port"] },
				{ kind: "text", value: "/" },
				{ kind: "ref", path: ["name"] },
			]);
		}
	});

	// Template with defaults
	it("parses template with defaults", () => {
		const result = parseExpression("${host:-localhost}:${port:-5432}");
		expect(result.kind).toBe("template");
		if (result.kind === "template") {
			expect(result.parts[0]).toEqual({ kind: "ref", path: ["host"], fallback: "localhost" });
			expect(result.parts[1]).toEqual({ kind: "text", value: ":" });
			expect(result.parts[2]).toEqual({ kind: "ref", path: ["port"], fallback: "5432" });
		}
	});

	// Template with $$ escape
	it("parses template with $$ escape", () => {
		const result = parseExpression("$$HOME/${name}");
		expect(result.kind).toBe("template");
		if (result.kind === "template") {
			expect(result.parts[0]).toEqual({ kind: "text", value: "$HOME/" });
			expect(result.parts[1]).toEqual({ kind: "ref", path: ["name"] });
		}
	});

	// Simple ${prop} without braces needed
	it("simplifies single-ref template to reference", () => {
		const result = parseExpression("${url}");
		expect(result).toEqual({ kind: "reference", path: ["url"] });
	});
});

/*---
req: REQ-413
type: unit
status: implemented
area: launch-spec
summary: Resolves parsed expressions against a deployment context
rationale: |
  Resolution is where Launchfile expressions become concrete values —
  $postgres.host becomes "postgres", $components.backend.url becomes
  "http://backend:3000". This powers the env var wiring that connects
  apps to their services and each other.
acceptance:
  - Resolves $url, $host, $port from enclosing resource
  - Resolves $postgres.host and $redis.url from services
  - Resolves $components.backend.url and named endpoints
  - Resolves composed templates with multiple refs
  - Uses fallback when property missing, ignores fallback when present
  - Resolves $$ to literal $
  - Resolves $secrets references
  - Returns empty string for missing properties
tags: [launch-spec, resolver, core]
source:
  type: implementation
  ref: implementation-discovery
changed:
  - date: 2026-03-28
    note: Backfilled by surface backfill
---*/
describe("resolveExpression", () => {
	const context = {
		resource: {
			url: "postgresql://user:pass@db:5432/myapp",
			host: "db",
			port: 5432,
			user: "myuser",
			password: "secret",
			name: "myapp",
		},
		resources: {
			postgres: {
				url: "postgresql://user:pass@db:5432/myapp",
				host: "db",
				port: 5432,
			},
			redis: {
				url: "redis://redis:6379/0",
				host: "redis",
				port: 6379,
			},
		},
		components: {
			backend: {
				url: "http://backend:3000",
				host: "backend",
				port: 3000,
				"metrics.url": "http://backend:9090",
			},
		},
	};

	// UC-2: Simple property
	it("resolves $url from enclosing resource", () => {
		expect(resolveExpression("$url", context)).toBe("postgresql://user:pass@db:5432/myapp");
	});

	// UC-3: Individual properties
	it("resolves $host from enclosing resource", () => {
		expect(resolveExpression("$host", context)).toBe("db");
	});

	it("resolves $port from enclosing resource (stringified)", () => {
		expect(resolveExpression("$port", context)).toBe("5432");
	});

	// UC-4: Literal
	it("returns literal string as-is", () => {
		expect(resolveExpression("postgresql", context)).toBe("postgresql");
	});

	// Cross-resource
	it("resolves $postgres.host", () => {
		expect(resolveExpression("$postgres.host", context)).toBe("db");
	});

	it("resolves $redis.url", () => {
		expect(resolveExpression("$redis.url", context)).toBe("redis://redis:6379/0");
	});

	// UC-9: Cross-component
	it("resolves $components.backend.url", () => {
		expect(resolveExpression("$components.backend.url", context)).toBe("http://backend:3000");
	});

	// UC-10: Named endpoint
	it("resolves $components.backend.metrics.url", () => {
		expect(resolveExpression("$components.backend.metrics.url", context)).toBe("http://backend:9090");
	});

	// UC-5: Composition
	it("resolves composed template", () => {
		expect(resolveExpression("jdbc:postgresql://${host}:${port}/${name}", context))
			.toBe("jdbc:postgresql://db:5432/myapp");
	});

	// UC-6: Default fallback
	it("uses fallback when property missing", () => {
		const emptyCtx = { resource: {} };
		expect(resolveExpression("${port:-5432}", emptyCtx)).toBe("5432");
	});

	it("uses property when available (ignores fallback)", () => {
		expect(resolveExpression("${port:-5432}", context)).toBe("5432");
	});

	// UC-17: Dollar escape
	it("resolves $$ to literal $", () => {
		expect(resolveExpression("$$HOME/bin", context)).toBe("$HOME/bin");
	});

	// Secrets namespace
	it("resolves $secrets.name from context", () => {
		const ctx = { secrets: { "jwt-secret": "abc123", "api-key": "xyz789" } };
		expect(resolveExpression("$secrets.jwt-secret", ctx)).toBe("abc123");
		expect(resolveExpression("$secrets.api-key", ctx)).toBe("xyz789");
	});

	it("resolves secrets in templates", () => {
		const ctx = { secrets: { token: "mytoken" } };
		expect(resolveExpression("Bearer ${secrets.token}", ctx)).toBe("Bearer mytoken");
	});

	it("returns empty for missing secret", () => {
		const ctx = { secrets: { token: "mytoken" } };
		expect(resolveExpression("$secrets.missing", ctx)).toBe("");
	});

	// D-32: Pipe transforms
	it("resolves $secrets.key|hex as the raw hex value", () => {
		const ctx = { secrets: { key: "deadbeef" } };
		expect(resolveExpression("$secrets.key|hex", ctx)).toBe("deadbeef");
	});

	it("resolves $secrets.key|base64 as base64-encoded bytes", () => {
		// "deadbeef" hex = bytes [0xde, 0xad, 0xbe, 0xef] = base64 "3q2+7w=="
		const ctx = { secrets: { key: "deadbeef" } };
		expect(resolveExpression("$secrets.key|base64", ctx)).toBe("3q2+7w==");
	});

	it("composes base64 with literal prefix (Laravel APP_KEY pattern)", () => {
		const ctx = { secrets: { "app-key": "deadbeef" } };
		expect(resolveExpression("base64:${secrets.app-key|base64}", ctx)).toBe("base64:3q2+7w==");
	});

	it("returns raw value for unknown transform", () => {
		const ctx = { secrets: { key: "deadbeef" } };
		expect(resolveExpression("$secrets.key|unknown", ctx)).toBe("deadbeef");
	});

	it("applies transforms to non-secret references", () => {
		const ctx = { resource: { host: "db.example.com" } };
		expect(resolveExpression("$host|base64", ctx)).toBe(btoa("db.example.com"));
	});

	it("parses pipe transforms in braced expressions", () => {
		const result = parseExpression("${secrets.key|base64}");
		expect(result).toEqual({
			kind: "reference",
			path: ["secrets", "key"],
			transforms: ["base64"],
		});
	});

	// Missing property with no fallback
	it("returns empty string for missing property", () => {
		const emptyCtx = { resource: {} };
		expect(resolveExpression("$url", emptyCtx)).toBe("");
	});
});

/*---
req: REQ-414
type: unit
status: implemented
area: launch-spec
summary: Resolves $app.* platform-injected app property references (D-33)
rationale: |
  $app.* is a reserved namespace for platform-injected properties of the
  deployed app itself: $app.url, $app.host, $app.port, $app.name. The
  provider's routing strategy populates these at deploy time so a Launchfile
  can reference its own public URL without hardcoding environment-specific
  values. The reserved 'app' prefix is checked first in resolution order so
  it cannot be shadowed by a user-named resource.
acceptance:
  - Resolves $app.url, $app.host, $app.port, $app.name from context.app
  - Stringifies numeric values like $app.port
  - Handles braced form ${app.url} and composed templates
  - Honors :- fallback when context.app is missing the property
  - Returns empty string when context.app is absent entirely
  - Reserved 'app' prefix wins over a user-named resource of the same name
  - Pipe transforms (e.g. |base64) compose with $app.* references
tags: [launch-spec, resolver, app-prefix]
---*/
describe("resolveExpression — $app.* prefix (D-33)", () => {
	const appContext = {
		app: {
			url: "https://my-app.example.com",
			host: "my-app.example.com",
			port: 10001,
			name: "my-app",
		},
	};

	it("resolves $app.url", () => {
		expect(resolveExpression("$app.url", appContext)).toBe("https://my-app.example.com");
	});

	it("resolves $app.host", () => {
		expect(resolveExpression("$app.host", appContext)).toBe("my-app.example.com");
	});

	it("resolves $app.port (stringified)", () => {
		expect(resolveExpression("$app.port", appContext)).toBe("10001");
	});

	it("resolves $app.name", () => {
		expect(resolveExpression("$app.name", appContext)).toBe("my-app");
	});

	it("resolves braced ${app.url}", () => {
		expect(resolveExpression("${app.url}", appContext)).toBe("https://my-app.example.com");
	});

	it("composes $app.url in templates with literal text", () => {
		expect(resolveExpression("${app.url}/oauth/callback", appContext))
			.toBe("https://my-app.example.com/oauth/callback");
	});

	it("uses fallback when context.app lacks the property", () => {
		const ctx = { app: { url: "https://my-app.example.com" } };
		expect(resolveExpression("${app.region:-us-east-1}", ctx)).toBe("us-east-1");
	});

	it("returns empty string when context.app is absent", () => {
		expect(resolveExpression("$app.url", {})).toBe("");
	});

	it("returns empty string for unknown $app.* property", () => {
		expect(resolveExpression("$app.region", appContext)).toBe("");
	});

	// Reserved-namespace check: a user-named resource called "app" must not
	// shadow $app.* — the reserved prefix wins because it is checked first.
	it("reserved $app.* is not shadowed by a user-named resource called 'app'", () => {
		const ctx = {
			app: { url: "https://my-app.example.com" },
			resources: {
				app: { url: "postgresql://user@db:5432/app" },
			},
		};
		expect(resolveExpression("$app.url", ctx)).toBe("https://my-app.example.com");
	});

	// D-32 + D-33: pipe transforms compose with $app.* references
	it("supports pipe transforms on $app.* references", () => {
		expect(resolveExpression("$app.host|base64", appContext)).toBe(btoa("my-app.example.com"));
	});

	// AppContext alongside other context types — verify no cross-talk
	it("resolves $app.* without disturbing other context lookups", () => {
		const ctx = {
			app: { url: "https://my-app.example.com" },
			resource: { host: "db", port: 5432 },
			secrets: { token: "abc123" },
		};
		expect(resolveExpression("$app.url", ctx)).toBe("https://my-app.example.com");
		expect(resolveExpression("$host", ctx)).toBe("db");
		expect(resolveExpression("$secrets.token", ctx)).toBe("abc123");
	});
});
