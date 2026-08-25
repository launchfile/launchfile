/**
 * The `required:` arrival table for the macos-dev provider's resolver half
 * (D-52, PROVIDERS.md §10 rule 8).
 *
 * Ported case-for-case from the AWS provider's table
 * (`providers/aws/src/__tests__/translate.test.ts`), verb-adjusted: AWS asserts
 * "no SSM parameter emitted, gap recorded", macos-dev asserts "key absent from
 * the resolved env, returned in `unsupplied`". The `up` and `env` branches are
 * in `provider-required-env.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { readLaunch } from "@launchfile/sdk";
import type { NormalizedComponent } from "@launchfile/sdk";
import type { ResourceProperties } from "../resources/types.js";
import { buildResolverContext, resolveComponentEnv } from "../env-writer.js";

const POSTGRES: ResourceProperties = {
	url: "postgresql://launchfile:pw@localhost:5432/app",
	host: "localhost",
	port: 5432,
	user: "launchfile",
	password: "pw",
	name: "app",
};

const resolve = (
	yaml: string,
	resourceMap: Record<string, ResourceProperties> = {},
	component = "default",
) => {
	const launch = readLaunch(yaml);
	const ctx = buildResolverContext(resourceMap, { [component]: 3000 }, {}, {
		name: launch.name,
		host: "localhost",
		port: 3000,
		url: "http://localhost:3000",
	});
	return resolveComponentEnv(
		launch.components[component] as NormalizedComponent,
		ctx,
		resourceMap,
	);
};

const REQUIRED = `
name: app
runtime: node
commands: { start: "node server.js" }
env:
  API_KEY:
    required: true
    sensitive: true
  SITE_URL:
    required: true
  HAS_DEFAULT:
    required: true
    default: fine
  GENERATED:
    required: true
    generator: secret
`;

describe("macos-dev — unsupplied required env (PROVIDERS.md rule 8, D-52)", () => {
	// 1
	it("leaves the key absent from the resolved env — absent, not empty", () => {
		const { env } = resolve(REQUIRED);
		expect("API_KEY" in env).toBe(false);
		expect("SITE_URL" in env).toBe(false);
	});

	// 2
	it("never invents a value for it", () => {
		const { env } = resolve(`
name: app
runtime: node
commands: { start: "node server.js" }
env:
  PGRST_DB_URI: { required: true }
  EMAIL_SMTP_HOST: { required: true }
  ADMIN_TOKEN: { required: true, sensitive: true }
`);
		const values = Object.values(env);
		expect(values).not.toContain("PLACEHOLDER");
		expect(values).not.toContain("http://localhost");
		expect(values).not.toContain("test@localhost");
		expect(env).toEqual({});
	});

	// 3
	it("still resolves vars the file supplies via default, and reports neither default nor generator", () => {
		const { env, unsupplied } = resolve(REQUIRED);
		expect(env.HAS_DEFAULT).toBe("fine");
		const keys = unsupplied.map((v) => v.key);
		expect(keys).not.toContain("HAS_DEFAULT");
		// `generator:` is minted later by resolveGenerators, so it is supplied by
		// the file even though it is absent from `env` at this point.
		expect(keys).not.toContain("GENERATED");
	});

	// 4
	it("treats a set_env binding on a provisioned resource as supplying the value", () => {
		const { env, unsupplied } = resolve(
			`
name: app
runtime: node
commands: { start: "node server.js" }
requires:
  - type: postgres
    set_env:
      DATABASE_URL: $url
env:
  DATABASE_URL:
    required: true
`,
			{ postgres: POSTGRES },
		);
		expect(env.DATABASE_URL).toBe(POSTGRES.url);
		expect(unsupplied).toEqual([]);
	});

	// 5
	it("does NOT treat a binding on an unprovisioned resource as supplying the value", () => {
		// No entry in resourceMap: the injection loop skips it, so the binding
		// declares the key without ever yielding one.
		const { env, unsupplied } = resolve(`
name: app
runtime: node
commands: { start: "node server.js" }
requires:
  - type: clickhouse
    set_env:
      CH_URL: $url
env:
  CH_URL:
    required: true
    sensitive: true
`);
		expect("CH_URL" in env).toBe(false);
		expect(unsupplied).toEqual([{ key: "CH_URL", sensitive: true }]);
	});

	// 6
	it("does NOT treat a supports-only binding as supplying the value", () => {
		const { env, unsupplied } = resolve(`
name: app
runtime: node
commands: { start: "node server.js" }
supports:
  - type: redis
    set_env:
      CACHE_URL: $url
env:
  CACHE_URL:
    required: true
`);
		expect("CACHE_URL" in env).toBe(false);
		expect(unsupplied.map((v) => v.key)).toEqual(["CACHE_URL"]);
	});

	// 7 — verb-adjusted: the obligation survives a component that is degraded for
	// an unrelated reason (an ungranted optional host capability, D-44).
	it("still reports it when the component is degraded for an unrelated reason", () => {
		const { unsupplied } = resolve(`
name: app
runtime: node
commands: { start: "node server.js" }
supports:
  - host: { docker: optional }
env:
  ADMIN_TOKEN:
    required: true
    sensitive: true
`);
		expect(unsupplied).toEqual([{ key: "ADMIN_TOKEN", sensitive: true }]);
	});

	// 8
	it("distinguishes sensitive vars in the report", () => {
		const { unsupplied } = resolve(REQUIRED);
		expect(unsupplied).toEqual([
			{ key: "API_KEY", sensitive: true },
			{ key: "SITE_URL", sensitive: false },
		]);
	});

	describe("scope boundary (D-52 §Scope — the empty-arrival route is L-4, not this)", () => {
		it("does not report a required var whose expression default resolves to empty", () => {
			const { env, unsupplied } = resolve(`
name: app
runtime: node
commands: { start: "node server.js" }
env:
  MAYBE_EMPTY:
    required: true
    default: $components.nope.url
`);
			expect(env.MAYBE_EMPTY).toBe("");
			expect(unsupplied).toEqual([]);
		});

		it("does not report a required var whose set_env binding resolves to empty", () => {
			const { env, unsupplied } = resolve(
				`
name: app
runtime: node
commands: { start: "node server.js" }
requires:
  - type: postgres
    set_env:
      DB_TOKEN: $nonexistent_property
env:
  DB_TOKEN:
    required: true
`,
				{ postgres: POSTGRES },
			);
			expect(env.DB_TOKEN).toBe("");
			expect(unsupplied).toEqual([]);
		});
	});
});
