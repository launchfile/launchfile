/**
 * The `required:` arrival table for the docker provider's generator half
 * (D-52, PROVIDERS.md §10 rule 8).
 *
 * Ported case-for-case from the AWS provider's table
 * (`providers/aws/src/__tests__/translate.test.ts`), verb-adjusted: AWS asserts
 * "no SSM parameter emitted, gap recorded", docker asserts "key absent from the
 * compose `environment:` map, recorded in `unsuppliedRequired`". The deploying
 * branch AWS has no verb for is in `provider-required-env.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readLaunch } from "@launchfile/sdk";
import { launchToCompose, type ComposeOpts } from "../compose-generator.js";

const compose = (yaml: string, opts: ComposeOpts = {}) => {
	const result = launchToCompose(readLaunch(yaml), opts);
	const doc = parse(result.yaml) as {
		services: Record<string, { environment?: Record<string, string> }>;
	};
	return { ...result, doc };
};

const REQUIRED = `
name: app
image: acme/app:1
provides:
  - { protocol: http, port: 3000, exposed: true }
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

describe("docker — unsupplied required env (PROVIDERS.md rule 8, D-52)", () => {
	// 1
	it("leaves the key absent from the emitted compose — absent, not empty", () => {
		const { doc } = compose(REQUIRED);
		const env = doc.services.app!.environment!;
		expect("API_KEY" in env).toBe(false);
		expect("SITE_URL" in env).toBe(false);
		expect(env.API_KEY).toBeUndefined();
		expect(env.SITE_URL).toBeUndefined();
	});

	// 2
	it("never invents a value for it", () => {
		const { yaml } = compose(REQUIRED);
		expect(yaml).not.toContain("PLACEHOLDER");
		expect(yaml).not.toContain("http://localhost");
		expect(yaml).not.toContain("test@localhost");
	});

	it("does not guess from the variable's name — the wrong-in-kind cases", () => {
		// D-52's own examples: a DSN slot, a hostname slot, an admin password.
		const { doc, unsuppliedRequired } = compose(`
name: app
image: acme/app:1
env:
  PGRST_DB_URI: { required: true }
  GOTRUE_DB_DATABASE_URL: { required: true }
  EMAIL_SMTP_HOST: { required: true }
  ADMIN_TOKEN: { required: true, sensitive: true }
`);
		expect(doc.services.app!.environment).toBeUndefined();
		expect(unsuppliedRequired.map((v) => v.key).sort()).toEqual([
			"ADMIN_TOKEN",
			"EMAIL_SMTP_HOST",
			"GOTRUE_DB_DATABASE_URL",
			"PGRST_DB_URI",
		]);
	});

	// 3
	it("still emits vars the file supplies via default or generator, and reports neither", () => {
		const { doc, unsuppliedRequired } = compose(REQUIRED);
		const env = doc.services.app!.environment!;
		expect(env.HAS_DEFAULT).toBe("fine");
		expect(env.GENERATED).toMatch(/^[0-9a-f]{64}$/);
		expect(unsuppliedRequired.map((v) => v.key)).not.toContain("HAS_DEFAULT");
		expect(unsuppliedRequired.map((v) => v.key)).not.toContain("GENERATED");
	});

	// 4
	it("treats a set_env binding on a resolved resource as supplying the value", () => {
		const { doc, unsuppliedRequired } = compose(`
name: app
image: acme/app:1
requires:
  - type: postgres
    set_env:
      DATABASE_URL: $url
env:
  DATABASE_URL:
    required: true
`);
		expect(doc.services.app!.environment!.DATABASE_URL).toContain("postgres://");
		expect(unsuppliedRequired).toEqual([]);
	});

	// 5
	it("does NOT treat a binding on an unmappable resource as supplying the value", () => {
		// `sqlite` is a valid resource type with no compose backing service, so
		// the binding declares the key without ever injecting it.
		const { yaml, unsuppliedRequired } = compose(`
name: app
image: acme/app:1
requires:
  - type: sqlite
    set_env:
      DB_URL: $url
env:
  DB_URL:
    required: true
    sensitive: true
`);
		expect(yaml).not.toContain("DB_URL");
		expect(unsuppliedRequired).toEqual([
			{ component: "default", key: "DB_URL", sensitive: true },
		]);
	});

	// 6
	it("does NOT treat a supports-only binding as supplying the value", () => {
		// SPEC.md §Supports: set_env injects only when the optional resource is
		// provisioned. This provider provisions no `supports:` resources.
		const { yaml, unsuppliedRequired } = compose(`
name: app
image: acme/app:1
supports:
  - type: redis
    set_env:
      CACHE_URL: $url
env:
  CACHE_URL:
    required: true
`);
		expect(yaml).not.toContain("CACHE_URL");
		expect(unsuppliedRequired.map((v) => v.key)).toEqual(["CACHE_URL"]);
	});

	// 7 — verb-adjusted: AWS's "component gaps for an unrelated reason" is a
	// conformance gap; docker's equivalent is a component that still generates a
	// service while carrying an unrelated warning.
	it("still reports it when the component warns for an unrelated reason", () => {
		const { warnings, unsuppliedRequired } = compose(`
name: app
components:
  worker:
    image: acme/worker:1
    schedule: "0 * * * *"
    supports:
      - host: { docker: optional }
    env:
      ADMIN_TOKEN:
        required: true
        sensitive: true
`);
		expect(warnings.some((w) => w.includes("schedule"))).toBe(true);
		expect(unsuppliedRequired).toEqual([
			{ component: "worker", key: "ADMIN_TOKEN", sensitive: true },
		]);
	});

	// 8
	it("distinguishes sensitive vars in the report, and names the component", () => {
		const { unsuppliedRequired } = compose(`
name: app
components:
  web:
    image: acme/web:1
    env:
      SITE_URL: { required: true }
  admin:
    image: acme/admin:1
    env:
      ADMIN_TOKEN: { required: true, sensitive: true }
`);
		expect(unsuppliedRequired).toEqual([
			{ component: "web", key: "SITE_URL", sensitive: false },
			{ component: "admin", key: "ADMIN_TOKEN", sensitive: true },
		]);
	});

	it("keeps unsupplied vars out of `warnings` — a deploying verb must fail, not warn", () => {
		// D-52's *Rejected* block: routing this through warnings produces exactly
		// the warn-then-proceed behavior the decision refuses.
		const { warnings } = compose(REQUIRED);
		expect(warnings.join("\n")).not.toContain("API_KEY");
		expect(warnings.join("\n")).not.toContain("SITE_URL");
	});

	it("never throws — it is exported public API and a pure generator", () => {
		expect(() => launchToCompose(readLaunch(REQUIRED))).not.toThrow();
	});

	describe("operator channel", () => {
		it("uses an operator-supplied value and stops reporting the var", () => {
			const { doc, unsuppliedRequired } = compose(REQUIRED, {
				operatorEnv: { API_KEY: "sk-real", SITE_URL: "https://wiki.example.com" },
			});
			const env = doc.services.app!.environment!;
			expect(env.API_KEY).toBe("sk-real");
			expect(env.SITE_URL).toBe("https://wiki.example.com");
			expect(unsuppliedRequired).toEqual([]);
		});

		it("never overrides a default, a generator, or a set_env binding", () => {
			const { doc } = compose(
				`
name: app
image: acme/app:1
requires:
  - type: postgres
    set_env:
      DATABASE_URL: $url
env:
  HAS_DEFAULT:
    required: true
    default: fine
  DATABASE_URL:
    required: true
`,
				{ operatorEnv: { HAS_DEFAULT: "hijacked", DATABASE_URL: "hijacked" } },
			);
			const env = doc.services.app!.environment!;
			expect(env.HAS_DEFAULT).toBe("fine");
			expect(env.DATABASE_URL).toContain("postgres://");
		});
	});

	describe("scope boundary (D-52 §Scope — the empty-arrival route is L-4, not this)", () => {
		it("does not report a required var whose expression default resolves to empty", () => {
			const { doc, unsuppliedRequired } = compose(`
name: app
image: acme/app:1
env:
  MAYBE_EMPTY:
    required: true
    default: $components.nope.url
`);
			expect(doc.services.app!.environment!.MAYBE_EMPTY).toBe("");
			expect(unsuppliedRequired).toEqual([]);
		});

		it("does not report a required var whose set_env binding resolves to empty", () => {
			const { unsuppliedRequired } = compose(`
name: app
image: acme/app:1
requires:
  - type: redis
    set_env:
      CACHE_TOKEN: $nonexistent_property
env:
  CACHE_TOKEN:
    required: true
`);
			expect(unsuppliedRequired).toEqual([]);
		});
	});
});
