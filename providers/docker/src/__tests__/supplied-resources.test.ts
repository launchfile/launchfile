/**
 * The orchestrator-satisfied resource channel (`ComposeOpts.resources`) —
 * proposal #289. A supplied entry wins over factory dispatch, emits no
 * backing service and no readiness gate, resolves `set_env` against the
 * supplied properties, warns on every gap (§10.8), and registers its
 * credential-bearing properties with the redactor before generation.
 */

import { readLaunch } from "@launchfile/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type ComposeOpts, launchToCompose } from "../compose-generator.js";
import { clearRegisteredSecrets, REDACTED, redactSecrets } from "../redact.js";

interface ComposeDoc {
	services: Record<
		string,
		{
			environment?: Record<string, string>;
			depends_on?: Record<string, { condition: string }>;
		}
	>;
	volumes?: Record<string, unknown>;
}

const compose = (yaml: string, opts: ComposeOpts = {}) => {
	const result = launchToCompose(readLaunch(yaml), opts);
	return { ...result, doc: parse(result.yaml) as ComposeDoc };
};

const PG_APP = `
name: app
image: acme/app:1
provides:
  - { protocol: http, port: 3000, exposed: true }
requires:
  - type: postgres
    set_env:
      DATABASE_URL: $url
      DB_HOST: $postgres.host
      DB_PASSWORD: $password
`;

const SUPPLIED_PG: ComposeOpts["resources"] = {
	postgres: {
		properties: {
			host: "db.internal.example.com",
			port: "5432",
			user: "app_rw",
			password: "supplied-rds-password-123",
			name: "app_production",
			url: "postgres://app_rw:supplied-rds-password-123@db.internal.example.com:5432/app_production",
		},
	},
};

beforeEach(() => {
	clearRegisteredSecrets();
});

describe("docker — orchestrator-satisfied resources (#289)", () => {
	it("emits no backing service, no depends_on, no volume, and no image pull for a satisfied requirement", () => {
		const { doc, images, warnings } = compose(PG_APP, {
			resources: SUPPLIED_PG,
		});

		expect(doc.services["app-postgres"]).toBeUndefined();
		expect(doc.services.app!.depends_on).toBeUndefined();
		expect(doc.volumes?.["app-postgres-data"]).toBeUndefined();
		expect(images).not.toContain("postgres:16-alpine");
		expect(warnings).toHaveLength(0);
	});

	it("resolves scoped $prop and $<resource>.* set_env against the supplied properties", () => {
		const { doc } = compose(PG_APP, { resources: SUPPLIED_PG });
		const env = doc.services.app!.environment!;

		expect(env.DATABASE_URL).toBe(SUPPLIED_PG!.postgres!.properties.url);
		expect(env.DB_HOST).toBe("db.internal.example.com");
		expect(env.DB_PASSWORD).toBe("supplied-rds-password-123");
	});

	it("supplied wins over the factory — the provisioned output is fully replaced, not merged", () => {
		const provisioned = compose(PG_APP);
		expect(provisioned.doc.services["app-postgres"]).toBeDefined();
		expect(provisioned.doc.services.app!.depends_on).toEqual({
			"app-postgres": { condition: "service_healthy" },
		});

		const supplied = compose(PG_APP, { resources: SUPPLIED_PG });
		expect(supplied.doc.services["app-postgres"]).toBeUndefined();
		expect(supplied.doc.services.app!.environment!.DB_HOST).toBe(
			"db.internal.example.com",
		);
	});

	it("satisfies a requires type this provider has no factory for — no unknown-type warning", () => {
		const { doc, warnings } = compose(
			`
name: app
image: acme/app:1
requires:
  - type: snowflake
    set_env:
      SNOWFLAKE_URL: $url
`,
			{
				resources: {
					snowflake: {
						properties: { url: "https://acct.snowflakecomputing.com" },
					},
				},
			},
		);

		expect(warnings.some((w) => w.includes("Unknown backing service"))).toBe(
			false,
		);
		expect(warnings).toHaveLength(0);
		expect(doc.services.app!.environment!.SNOWFLAKE_URL).toBe(
			"https://acct.snowflakecomputing.com",
		);
	});

	it("keys by name when the entry has one, and satisfies per entry — a same-type sibling still provisions", () => {
		const { doc, warnings } = compose(
			`
name: app
image: acme/app:1
requires:
  - name: maindb
    type: postgres
    set_env:
      MAIN_DB_HOST: $host
  - type: postgres
    set_env:
      SCRATCH_DB_HOST: $host
`,
			{ resources: { maindb: { properties: { host: "pooled.internal" } } } },
		);

		const env = doc.services.app!.environment!;
		expect(env.MAIN_DB_HOST).toBe("pooled.internal");
		// The unsupplied same-type entry keeps its shared backing service and gate.
		expect(doc.services["app-postgres"]).toBeDefined();
		expect(env.SCRATCH_DB_HOST).toBe("app-postgres");
		expect(doc.services.app!.depends_on).toEqual({
			"app-postgres": { condition: "service_healthy" },
		});
		expect(warnings).toHaveLength(0);
	});

	describe("warnings (§10.8)", () => {
		it("warns on a supplied key matching no requires/supports entry", () => {
			const { warnings } = compose(PG_APP, {
				resources: {
					...SUPPLIED_PG,
					postgress: { properties: { host: "typo.example.com" } },
				},
			});

			expect(warnings).toContain(
				"supplied resource postgress matches no `requires`/`supports` entry — ignored",
			);
		});

		it('warns and resolves "" when set_env references a property the supplied entry does not provide', () => {
			const { doc, warnings } = compose(PG_APP, {
				resources: {
					postgres: {
						properties: { host: "db.internal.example.com", port: "5432" },
					},
				},
			});

			const env = doc.services.app!.environment!;
			expect(env.DATABASE_URL).toBe("");
			expect(env.DB_PASSWORD).toBe("");
			expect(env.DB_HOST).toBe("db.internal.example.com");
			expect(warnings).toContain(
				'default: set_env references postgres.url, which the supplied resource does not provide — resolved to ""',
			);
			expect(warnings).toContain(
				'default: set_env references postgres.password, which the supplied resource does not provide — resolved to ""',
			);
		});

		it("does not warn on a missing property whose reference carries a fallback", () => {
			const { doc, warnings } = compose(
				`
name: app
image: acme/app:1
requires:
  - type: postgres
    set_env:
      DB_PORT: \${port:-5432}
`,
				{ resources: { postgres: { properties: { host: "db.internal" } } } },
			);

			expect(doc.services.app!.environment!.DB_PORT).toBe("5432");
			expect(warnings).toHaveLength(0);
		});

		it("warns on requires.config the provider cannot apply to a resource it does not own", () => {
			const { doc, warnings } = compose(
				`
name: app
image: acme/app:1
requires:
  - type: postgres
    config:
      extensions: [pgvector]
    set_env:
      DATABASE_URL: $url
`,
				{ resources: SUPPLIED_PG },
			);

			expect(warnings).toContain(
				"default: config on postgres cannot be applied — the resource is orchestrator-supplied, not provisioned by this provider — ignored",
			);
			// The config was not silently half-honored either: no service, no image swap.
			expect(doc.services["app-postgres"]).toBeUndefined();
		});
	});

	describe("supports: entries", () => {
		const SUPPORTS_APP = `
name: app
image: acme/app:1
supports:
  - type: redis
    set_env:
      REDIS_URL: $url
`;

		it("injects a supplied supports entry's set_env — the only path those bindings can fire on this provider", () => {
			const { doc, warnings } = compose(SUPPORTS_APP, {
				resources: {
					redis: { properties: { url: "redis://pooled.internal:6379" } },
				},
			});

			expect(doc.services.app!.environment!.REDIS_URL).toBe(
				"redis://pooled.internal:6379",
			);
			expect(doc.services["app-redis"]).toBeUndefined();
			expect(doc.services.app!.depends_on).toBeUndefined();
			expect(warnings).toHaveLength(0);
		});

		it("injects nothing and warns when a supports entry has no supplied match", () => {
			const { doc, warnings } = compose(SUPPORTS_APP);

			expect(doc.services.app!.environment).toBeUndefined();
			expect(doc.services["app-redis"]).toBeUndefined();
			expect(warnings).toContain(
				"default: optional resource redis is not satisfied — this provider does not provision `supports:` resources and none was supplied; its set_env bindings are omitted and the app runs degraded",
			);
		});
	});

	describe("redaction (D-46 classification, before generation)", () => {
		it("scrubs a supplied password out of captured output", () => {
			compose(PG_APP, { resources: SUPPLIED_PG });

			const captured = `container exited: FATAL password authentication failed for "supplied-rds-password-123"`;
			expect(redactSecrets(captured)).toBe(
				`container exited: FATAL password authentication failed for "${REDACTED}"`,
			);
		});

		it("registers the supplied credentials even when the key matches no requirement", () => {
			compose("name: app\nimage: acme/app:1\n", {
				resources: {
					orphan: { properties: { password: "orphaned-credential-9" } },
				},
			});

			expect(redactSecrets("saw orphaned-credential-9 in logs")).toBe(
				`saw ${REDACTED} in logs`,
			);
		});

		it("leaves structural properties unregistered so diagnostics stay readable", () => {
			compose(PG_APP, { resources: SUPPLIED_PG });

			const diagnostic =
				"connect to db.internal.example.com as app_rw db app_production";
			expect(redactSecrets(diagnostic)).toBe(diagnostic);
		});

		it("fails closed: a property outside the type's D-46 vocabulary registers as a credential", () => {
			compose(PG_APP, {
				resources: {
					postgres: {
						properties: {
							...SUPPLIED_PG!.postgres!.properties,
							session_token: "tok-fail-closed-77",
						},
					},
				},
			});

			expect(redactSecrets("token tok-fail-closed-77 rejected")).toBe(
				`token ${REDACTED} rejected`,
			);
		});

		it("still scrubs a credential embedded in a supplied url via the pattern layer", () => {
			// `url` is structural and unregistered, but the existing pattern scrub
			// covers scheme://user:pass@host regardless of registration.
			expect(
				redactSecrets(
					"dialing postgres://app_rw:some-unregistered-pw@db.internal:5432/app",
				),
			).toBe(`dialing postgres://app_rw:${REDACTED}@db.internal:5432/app`);
		});
	});
});
