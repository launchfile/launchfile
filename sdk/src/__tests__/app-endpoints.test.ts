import { describe, expect, it } from "vitest";
import { appEndpointReferences, lintLaunch } from "../lint.js";
import { readLaunch } from "../reader.js";
import {
	APP_ENDPOINT_PROPERTIES,
	type ResolverContext,
	resolveExpression,
	UNPUBLISHED_APP_ENDPOINT,
} from "../resolver.js";

/**
 * `$app.endpoints.<name>.*` — per-endpoint publication context (D-next).
 *
 * The resolver half: only the four-segment form addresses a value, from a
 * sibling map on the context; every other shape resolves "" (rule 4, L-4).
 * The `validate` half: the shapes that resolve "" are named at validate time,
 * and a `provides[].name` on two components is refused.
 */

const CONTEXT: ResolverContext = {
	app: {
		name: "gitea",
		url: "https://localhost:13000",
		host: "localhost",
		port: 13000,
		authority: "localhost:13000",
		scheme: "https",
		tls: "true",
	},
	appEndpoints: {
		web: {
			url: "https://localhost:13000",
			host: "localhost",
			port: 13000,
			authority: "localhost:13000",
			scheme: "https",
			tls: "true",
		},
		ssh: {
			url: "",
			host: "localhost",
			port: 49222,
			authority: "localhost:49222",
			scheme: "",
			tls: "false",
		},
	},
	resources: {
		app: { url: "postgresql://user@db:5432/app", endpoints: "shadow" },
	},
};

describe("resolveExpression — $app.endpoints.<name>.<prop> (D-next)", () => {
	it("resolves every one of the six properties", () => {
		expect(resolveExpression("$app.endpoints.ssh.host", CONTEXT)).toBe(
			"localhost",
		);
		expect(resolveExpression("$app.endpoints.ssh.port", CONTEXT)).toBe("49222");
		expect(resolveExpression("$app.endpoints.ssh.authority", CONTEXT)).toBe(
			"localhost:49222",
		);
		expect(resolveExpression("$app.endpoints.web.url", CONTEXT)).toBe(
			"https://localhost:13000",
		);
		expect(resolveExpression("$app.endpoints.web.scheme", CONTEXT)).toBe(
			"https",
		);
		expect(resolveExpression("$app.endpoints.web.tls", CONTEXT)).toBe("true");
	});

	it("names exactly the standard $app.* set less `name`", () => {
		expect([...APP_ENDPOINT_PROPERTIES]).toEqual([
			"url",
			"host",
			"port",
			"scheme",
			"authority",
			"tls",
		]);
	});

	it("reads the primary's entry as the same value $app.* holds (rule 2)", () => {
		for (const prop of APP_ENDPOINT_PROPERTIES) {
			expect(resolveExpression(`$app.endpoints.web.${prop}`, CONTEXT)).toBe(
				resolveExpression(`$app.${prop}`, CONTEXT),
			);
		}
	});

	it("gives a tcp endpoint its defined empty url and scheme, tls false (rule 3)", () => {
		expect(resolveExpression("$app.endpoints.ssh.url", CONTEXT)).toBe("");
		expect(resolveExpression("$app.endpoints.ssh.scheme", CONTEXT)).toBe("");
		expect(resolveExpression("$app.endpoints.ssh.tls", CONTEXT)).toBe("false");
	});

	it("composes in braced and template forms", () => {
		expect(resolveExpression("${app.endpoints.ssh.port}", CONTEXT)).toBe(
			"49222",
		);
		expect(
			resolveExpression(
				"ssh://git@${app.endpoints.ssh.host}:${app.endpoints.ssh.port}/org/repo.git",
				CONTEXT,
			),
		).toBe("ssh://git@localhost:49222/org/repo.git");
	});

	it("resolves the two-segment form to nothing — no `endpoints` key lives in context.app", () => {
		expect(resolveExpression("$app.endpoints", CONTEXT)).toBe("");
	});

	it("resolves the three-segment form to nothing (rule 4)", () => {
		expect(resolveExpression("$app.endpoints.ssh", CONTEXT)).toBe("");
	});

	it("resolves an unknown name, an unknown property, and a deeper path to nothing (rule 4)", () => {
		expect(resolveExpression("$app.endpoints.sshd.host", CONTEXT)).toBe("");
		expect(resolveExpression("$app.endpoints.ssh.ip", CONTEXT)).toBe("");
		expect(resolveExpression("$app.endpoints.ssh.port.high", CONTEXT)).toBe("");
	});

	it("resolves to nothing when the provider registered no endpoint map (older provider, L-4)", () => {
		const { appEndpoints: _omitted, ...withoutMap } = CONTEXT;
		expect(resolveExpression("$app.endpoints.ssh.port", withoutMap)).toBe("");
	});

	it("resolves every property of an unpublished endpoint to nothing (rule 4)", () => {
		const ctx: ResolverContext = {
			appEndpoints: { ssh: UNPUBLISHED_APP_ENDPOINT },
		};
		for (const prop of APP_ENDPOINT_PROPERTIES) {
			expect(resolveExpression(`$app.endpoints.ssh.${prop}`, ctx)).toBe("");
		}
	});

	it("honours a `:-default` fallback on an unresolved reference, not on a defined empty answer", () => {
		// Rule 4's unknown name is unresolved, so the fallback stands in.
		expect(
			resolveExpression("${app.endpoints.sshd.host:-example.org}", CONTEXT),
		).toBe("example.org");
		// Rule 3's "" for a tcp url is a value, exactly as `$app.url` is "" for
		// an app that publishes nothing — present, so no fallback applies.
		expect(resolveExpression("${app.endpoints.ssh.url:-none}", CONTEXT)).toBe(
			"",
		);
	});

	it("is reserved — a user resource named `app` cannot shadow it", () => {
		expect(resolveExpression("$app.endpoints.ssh.port", CONTEXT)).toBe("49222");
		expect(resolveExpression("$app.endpoints", CONTEXT)).toBe("");
	});

	it("leaves a four-segment path under any other second segment on today's behaviour", () => {
		const ctx: ResolverContext = {
			...CONTEXT,
			resources: { app: { "region.zone.id": "eu-1" } },
		};
		expect(resolveExpression("$app.region.zone.id", ctx)).toBe("eu-1");
	});

	it("never reads an inherited Object.prototype key as an endpoint", () => {
		expect(resolveExpression("$app.endpoints.constructor.url", CONTEXT)).toBe(
			"",
		);
	});
});

const GITEA_SHAPE = `
name: gitea
image: gitea/gitea:latest
provides:
  - name: web
    protocol: http
    port: 3000
    exposed: true
  - name: ssh
    protocol: tcp
    port: 22
    exposed: true
  - name: metrics
    protocol: http
    port: 9090
env:
  ROOT_URL:
    default: $app.url
  SSH_DOMAIN:
    default: $app.endpoints.ssh.host
  SSH_PORT:
    default: $app.endpoints.ssh.port
`;

const lint = (yaml: string): string[] =>
	lintLaunch(readLaunch(yaml), { suppressPortabilityWarnings: true });

describe("validate — $app.endpoints references (D-next rule 4)", () => {
	it("is silent for a reference to a named published endpoint, tcp included", () => {
		expect(lint(GITEA_SHAPE)).toEqual([]);
	});

	it("warns when the form names no endpoint", () => {
		const warnings = lint(
			`${GITEA_SHAPE}  BARE:\n    default: $app.endpoints\n`,
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(
			"default: env.BARE references `$app.endpoints`",
		);
		expect(warnings[0]).toContain("names no endpoint");
		expect(warnings[0]).toContain('resolves ""');
	});

	it("warns when the form names no property", () => {
		const warnings = lint(
			`${GITEA_SHAPE}  NOPROP:\n    default: $app.endpoints.ssh\n`,
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("`$app.endpoints.ssh`");
		expect(warnings[0]).toContain("names no property");
	});

	it("warns on a name no provides entry carries, listing the named published ones", () => {
		const warnings = lint(
			`${GITEA_SHAPE}  TYPO:\n    default: $app.endpoints.sshd.port\n`,
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('no `provides` entry is named "sshd"');
		expect(warnings[0]).toContain("named published endpoints: web, ssh");
	});

	it("tells an app with no named endpoint to add a `name:` (D-6)", () => {
		const warnings = lint(`
name: unnamed
image: acme/app:1
provides:
  - protocol: http
    port: 8080
    exposed: true
env:
  HOST:
    default: $app.endpoints.web.host
`);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("add one to the entry this references");
	});

	it("warns on a named endpoint that is not exposed (D-27)", () => {
		const warnings = lint(
			`${GITEA_SHAPE}  METRICS:\n    default: $app.endpoints.metrics.port\n`,
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(
			'endpoint "metrics" on default is not `exposed: true`',
		);
	});

	it("warns on a property outside the six, and on a deeper path", () => {
		const warnings = lint(
			`${GITEA_SHAPE}  IP:\n    default: $app.endpoints.ssh.ip\n  DEEP:\n    default: $app.endpoints.ssh.port.high\n`,
		);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain('"ip" is not a per-endpoint property');
		expect(warnings[0]).toContain("url, host, port, scheme, authority, tls");
		expect(warnings[1]).toContain('"port.high" is not a per-endpoint property');
	});

	it("sees references inside templates and set_env bindings, across components", () => {
		const warnings = lint(`
name: multi
components:
  api:
    image: api:1
    provides:
      - name: web
        protocol: http
        port: 8080
        exposed: true
    requires:
      - type: postgres
        set_env:
          DATABASE_URL: "postgres://x@$host/\${app.endpoints.nope.host}"
  worker:
    image: worker:1
    env:
      PEER:
        default: "\${app.endpoints.web.host}:\${app.endpoints.web.port}"
`);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(
			"api: requires[postgres].set_env.DATABASE_URL",
		);
		expect(warnings[0]).toContain('"nope"');
	});
});

describe("appEndpointReferences", () => {
	it("lists every reference with its component, site and path", () => {
		const refs = appEndpointReferences(readLaunch(GITEA_SHAPE));
		expect(refs).toEqual([
			{
				component: "default",
				site: "env.SSH_DOMAIN",
				path: ["app", "endpoints", "ssh", "host"],
			},
			{
				component: "default",
				site: "env.SSH_PORT",
				path: ["app", "endpoints", "ssh", "port"],
			},
		]);
	});

	it("ignores $app.* references that are not endpoint references", () => {
		expect(
			appEndpointReferences(
				readLaunch(`
name: plain
image: acme/app:1
env:
  URL:
    default: $app.url
`),
			),
		).toEqual([]);
	});
});

describe("validate — a provides name on two components is refused (D-next rule 4)", () => {
	it("names both components", () => {
		expect(() =>
			readLaunch(`
name: twins
components:
  api:
    image: api:1
    provides:
      - name: web
        protocol: http
        port: 8080
        exposed: true
  admin:
    image: admin:1
    provides:
      - name: web
        protocol: http
        port: 9090
        exposed: true
`),
		).toThrow(/web.*is named on both api and admin/);
	});

	it("accepts distinct names across components", () => {
		const launch = readLaunch(`
name: twins
components:
  api:
    image: api:1
    provides:
      - name: web
        protocol: http
        port: 8080
        exposed: true
  admin:
    image: admin:1
    provides:
      - name: admin-ui
        protocol: http
        port: 9090
        exposed: true
`);
		expect(Object.keys(launch.components)).toEqual(["api", "admin"]);
	});
});
