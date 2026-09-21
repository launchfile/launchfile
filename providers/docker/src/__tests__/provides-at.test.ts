/**
 * `at:` on a `provides` entry on `@launchfile/docker` (D-68 rule 5): a
 * provider provisions every declared name or refuses the component before
 * launch. This provider publishes ports and routes no host names, and a
 * supplied publication URL states the app host's address, not which `at:`
 * values an orchestrator covers — so every declaring component is refused.
 *
 * Every refusal test asserts the outcome (the service is absent), never only
 * the message.
 */

import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { computeAppContext } from "../app-url.js";
import { type ComposeOpts, launchToCompose } from "../compose-generator.js";

interface ComposeDoc {
	services: Record<string, { image?: string; ports?: string[] }>;
}

const compose = (yaml: string, opts: ComposeOpts = {}) => {
	const result = launchToCompose(readLaunch(yaml), opts);
	return { ...result, doc: parse(result.yaml) as ComposeDoc };
};

const refusals = (warnings: string[]) =>
	warnings.filter((w) => w.startsWith("refused:"));

const app = (at: string) => `
name: app
image: acme/app:1
provides:
  - name: web
    protocol: http
    port: 8080
    exposed: true
    at: ${at}
`;

describe("provides: an entry declaring `at:` is refused (D-68 rule 5)", () => {
	it("refuses the component: no service, no image", () => {
		const { doc, images, warnings } = compose(app('["@", dash, "*"]'));
		expect(doc.services.app).toBeUndefined();
		expect(images).toEqual([]);
		expect(refusals(warnings)).toHaveLength(1);
	});

	it("names the entry and every declared value", () => {
		const [refusal] = refusals(compose(app('["@", dash, "*"]')).warnings);
		expect(refusal).toContain('`provides` entry "web" on default');
		expect(refusal).toContain('"@"');
		expect(refusal).toContain('"dash"');
		expect(refusal).toContain('"*"');
	});

	it("says what this provider does and why nothing can cover the values yet", () => {
		const [refusal] = refusals(compose(app('["@", dash]')).warnings);
		expect(refusal).toBe(
			"refused: default declares `at:` host names this provider cannot cover " +
				'(`provides` entry "web" on default: "@", "dash") — this provider publishes ports ' +
				"and routes no host names, and an orchestrator-supplied statement of the values it " +
				"covers is not available yet (#543); use a provider that provisions the names — " +
				"component skipped",
		);
	});

	it("refuses the scalar form, which parses to a one-value list", () => {
		const { doc, warnings } = compose(app('"@"'));
		expect(doc.services.app).toBeUndefined();
		expect(refusals(warnings)[0]).toContain('on default: "@")');
	});

	it("names an unnamed entry by position", () => {
		const { warnings } = compose(`
name: app
image: acme/app:1
provides:
  - protocol: http
    port: 8080
    exposed: true
    at: dash
`);
		expect(refusals(warnings)[0]).toContain(
			'`provides` entry #1 (unnamed) on default: "dash"',
		);
	});

	it("lists every declaring entry of the component in one refusal", () => {
		const { warnings } = compose(`
name: app
image: acme/app:1
provides:
  - name: web
    protocol: http
    port: 8080
    exposed: true
    at: "@"
  - name: admin
    protocol: http
    port: 9090
    exposed: true
    at: ["*", "*.*"]
`);
		expect(refusals(warnings)).toHaveLength(1);
		expect(refusals(warnings)[0]).toContain(
			'(`provides` entry "web" on default: "@"; `provides` entry "admin" on default: "*", "*.*")',
		);
	});
});

describe("a supplied publication URL covers no `at:` value", () => {
	it("still refuses the component under an https appUrl", () => {
		const { doc, images, warnings } = compose(app('["@", dash, "*"]'), {
			appUrl: "https://app.example.com",
		});
		expect(doc.services.app).toBeUndefined();
		expect(images).toEqual([]);
		expect(refusals(warnings)).toHaveLength(1);
		expect(refusals(warnings)[0]).toContain(
			'`provides` entry "web" on default: "@", "dash", "*"',
		);
	});
});

describe("the refusal is per component", () => {
	const TWO = `
name: app
components:
  web:
    image: acme/web:1
    provides:
      - name: web
        protocol: http
        port: 8080
        exposed: true
        at: ["@", dash, "*"]
  worker:
    image: acme/worker:1
`;

	it("a sibling that declares no `at:` is still generated", () => {
		const { doc, images, warnings } = compose(TWO);
		expect(doc.services["app-web"]).toBeUndefined();
		expect(doc.services["app-worker"]).toBeDefined();
		expect(images).toEqual(["acme/worker:1"]);
		expect(refusals(warnings)).toHaveLength(1);
		expect(refusals(warnings)[0]).toMatch(/^refused: web /);
	});
});

/** The whole compose file for the `at:`-free app below, under a pinned host port. */
const PLAIN_COMPOSE = `services:
  plain:
    image: acme/app:1
    ports:
      - 18080:8080
    environment:
      APP_URL: http://localhost:18080
    restart: unless-stopped
    networks:
      - launchfile-plain-net
networks:
  launchfile-plain-net:
    driver: bridge
`;

describe("apps that declare no `at:`", () => {
	const PLAIN = `
name: plain
image: acme/app:1
provides:
  - name: web
    protocol: http
    port: 8080
    exposed: true
env:
  APP_URL: $app.url
`;

	it("are not refused", () => {
		const { doc, warnings } = compose(PLAIN);
		expect(doc.services.plain).toBeDefined();
		expect(refusals(warnings)).toEqual([]);
	});

	it("generate a byte-identical compose file", () => {
		const { yaml, warnings } = compose(PLAIN, {
			hostPorts: { default: 18080 },
		});
		expect(yaml).toBe(PLAIN_COMPOSE);
		expect(warnings).toEqual([]);
	});
});

describe("`at:` changes no reference value (D-68 rule 6)", () => {
	const twoEndpoints = (at: string) => `
name: app
image: acme/app:1
provides:
  - name: web
    protocol: http
    port: 8080
    exposed: true
${at}
  - name: admin
    protocol: http
    port: 9090
    exposed: true
requires:
  - type: https-origin
    endpoint: web
`;
	const declared = readLaunch(twoEndpoints('    at: ["@", dash, "*", "*.*"]'));
	const bare = readLaunch(twoEndpoints(""));
	const hostPorts = { web: 18080, admin: 19090 };

	it("declares `at:` on one fixture only, so the comparison is not empty", () => {
		expect(declared.components.default?.provides?.[0]?.at).toEqual([
			"@",
			"dash",
			"*",
			"*.*",
		]);
		expect(bare.components.default?.provides?.[0]?.at).toBeUndefined();
	});

	it("computes the same `$app.*` and `$app.endpoints.*` from the provider's own publication", () => {
		const withAt = computeAppContext(declared, hostPorts);
		expect(withAt).toEqual(computeAppContext(bare, hostPorts));
		expect(withAt.appEndpoints.web?.url).not.toBe("");
	});

	it("computes the same values under a supplied publication URL", () => {
		const url = "https://app.example.com";
		const withAt = computeAppContext(declared, hostPorts, url);
		expect(withAt).toEqual(computeAppContext(bare, hostPorts, url));
		expect(withAt.app.host).toBe("app.example.com");
	});
});
