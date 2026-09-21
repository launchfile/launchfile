/**
 * `at:` on a `provides` entry on `@launchfile/docker` (D-68 rule 5). This
 * provider publishes the listener's port and sets up no host names, so every
 * request reaches the listener with its `Host` intact and only name resolution
 * is left to the operator. It launches the component and reports the names —
 * never a silent launch, never a refusal.
 *
 * Every test asserts the outcome (the service is generated), never only the
 * message.
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

const reports = (warnings: string[]) =>
	warnings.filter((w) => w.includes("(`at:`, D-68)"));

describe("provides: an entry declaring `at:` launches and is reported (D-68 rule 5)", () => {
	it("generates the component and refuses nothing", () => {
		const { doc, images, warnings } = compose(app('["@", dash, "*"]'));
		expect(doc.services.app).toBeDefined();
		expect(images).toEqual(["acme/app:1"]);
		expect(refusals(warnings)).toEqual([]);
		expect(reports(warnings)).toHaveLength(1);
	});

	it("generates the same compose file as the same app without `at:`", () => {
		const withAt = compose(app('["@", dash, "*"]'), {
			hostPorts: { default: 18080 },
		});
		const bare = compose(app('["@"]').replace('    at: ["@"]\n', ""), {
			hostPorts: { default: 18080 },
		});
		expect(bare.warnings).toEqual([]);
		expect(withAt.yaml).toBe(bare.yaml);
	});

	it("names the entry and every name it answers at, under the app host", () => {
		const [report] = reports(compose(app('["@", dash, "*", "*.*"]')).warnings);
		expect(report).toContain('`provides` entry "web" on default');
		expect(report).toContain(
			"answers at localhost, dash.localhost, *.localhost, *.*.localhost",
		);
	});

	it("says where requests arrive and what the operator can do", () => {
		const [report] = reports(
			compose(app('["@", dash]'), { hostPorts: { default: 18080 } }).warnings,
		);
		expect(report).toBe(
			'`provides` entry "web" on default answers at localhost, dash.localhost (`at:`, D-68) — ' +
				"this provider publishes the port and sets up no host names. Every request that " +
				"reaches localhost:18080 reaches the listener with its `Host` intact, so map each " +
				"name that does not resolve to this machine (hosts file or DNS), or use a provider " +
				"that routes host names",
		);
	});

	it("reports the scalar form, which parses to a one-value list", () => {
		const { doc, warnings } = compose(app("dash"));
		expect(doc.services.app).toBeDefined();
		expect(reports(warnings)[0]).toContain("answers at dash.localhost (");
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
		expect(reports(warnings)[0]).toContain(
			"`provides` entry #1 (unnamed) on default answers at dash.localhost",
		);
	});

	it("reports each declaring entry on its own, with its own published address", () => {
		const { warnings } = compose(
			`
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
`,
		);
		const [web, admin] = reports(warnings);
		expect(reports(warnings)).toHaveLength(2);
		expect(web).toContain('entry "web" on default answers at localhost (');
		expect(web).toContain("reaches localhost:8080 ");
		expect(admin).toContain(
			'entry "admin" on default answers at *.localhost, *.*.localhost (',
		);
		expect(admin).toContain("reaches localhost:9090 ");
	});
});

describe("under a supplied publication URL (D-68 rule 7)", () => {
	it("still launches, and reports the names under the supplied host", () => {
		const { doc, warnings } = compose(app('["@", dash, "*"]'), {
			appUrl: "https://app.example.com",
		});
		expect(doc.services.app).toBeDefined();
		expect(refusals(warnings)).toEqual([]);
		const [report] = reports(warnings);
		expect(report).toContain(
			"answers at app.example.com, dash.app.example.com, *.app.example.com",
		);
		expect(report).toContain(
			"the supplied publication URL (https://app.example.com) says nothing about them",
		);
	});
});

describe("components that declare no `at:`", () => {
	it("draw no report beside a sibling that declares it", () => {
		const { doc, warnings } = compose(`
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
`);
		expect(doc.services["app-web"]).toBeDefined();
		expect(doc.services["app-worker"]).toBeDefined();
		expect(reports(warnings)).toHaveLength(1);
		expect(reports(warnings)[0]).toContain('entry "web" on web');
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

	it("draw no report", () => {
		const { doc, warnings } = compose(PLAIN);
		expect(doc.services.plain).toBeDefined();
		expect(warnings).toEqual([]);
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
