import { describe, expect, it } from "vitest";
import { readLaunch } from "../reader.js";
import { RESOURCE_PROPERTY_VOCABULARY } from "../resource-properties.js";
import { writeLaunch } from "../writer.js";

/**
 * `https-origin` — the declaration and its two cross-field rules (D-next).
 *
 * Rule 2 (the endpoint reference) and rule 3 (one per app) cannot be expressed
 * per entry: both need the whole file. They are hard validation errors, not
 * lint advisories, because a silently skipped declaration is the exact failure
 * the type exists to remove.
 */

/** Build a single-component file whose one listener speaks `protocol`. */
function withProtocol(protocol: string, endpoint = "web"): string {
	return `
name: app
image: app:1
provides:
  - name: web
    protocol: ${protocol}
    port: 8080
    exposed: true
requires:
  - type: https-origin
    endpoint: ${endpoint}
`;
}

describe("https-origin declaration", () => {
	it("parses a requires entry with set_env wiring", () => {
		const launch = readLaunch(`
name: vaultwarden
image: vaultwarden/server:latest
provides:
  - name: web
    protocol: http
    port: 80
    exposed: true
requires:
  - type: https-origin
    endpoint: web
    set_env:
      DOMAIN: $url
`);
		const req = launch.components.default!.requires![0]!;
		expect(req.type).toBe("https-origin");
		expect(req.endpoint).toBe("web");
		expect(req.set_env).toEqual({ DOMAIN: "$url" });
	});

	it("parses a supports entry — the optional mood (rule 6)", () => {
		const launch = readLaunch(`
name: grocy
image: linuxserver/grocy:latest
provides:
  - name: web
    protocol: http
    port: 80
    exposed: true
supports:
  - type: https-origin
    endpoint: web
`);
		expect(launch.components.default!.supports![0]!.endpoint).toBe("web");
	});

	it("survives a parse → serialize round trip", () => {
		const source = `
name: app
image: app:1
provides:
  - name: web
    protocol: http
    port: 80
    exposed: true
requires:
  - type: https-origin
    endpoint: web
`;
		const yaml = writeLaunch(readLaunch(source));
		expect(yaml).toContain("type: https-origin");
		expect(yaml).toContain("endpoint: web");
		expect(readLaunch(yaml).components.default!.requires![0]!.endpoint).toBe(
			"web",
		);
	});

	it("registers exactly one property, `url` (rule 4)", () => {
		expect(RESOURCE_PROPERTY_VOCABULARY["https-origin"]).toEqual(["url"]);
	});
});

describe("rule 2 — the endpoint reference", () => {
	it.each(["http", "https", "ws", "grpc"])(
		"accepts an HTTP-family listener: %s",
		(protocol) => {
			expect(() => readLaunch(withProtocol(protocol))).not.toThrow();
		},
	);

	// A ZodError's `message` is the JSON dump of its issues, so the quotes around
	// an endpoint name arrive backslash-escaped. `\\?"` matches either spelling,
	// keeping the assertion on the wording rather than on the serialization.
	it.each(["tcp", "udp"])("rejects a %s listener with the rule-2 message", (protocol) => {
		expect(() => readLaunch(withProtocol(protocol))).toThrow(
			new RegExp(
				`https-origin endpoint \\\\?"web\\\\?" declares \`protocol: ${protocol}\``,
			),
		);
	});

	it("names the endpoint and its protocol, and points at the web endpoint", () => {
		expect(() =>
			readLaunch(`
name: mailpit
image: axllent/mailpit:latest
provides:
  - name: web-ui
    protocol: http
    port: 8025
    exposed: true
  - name: smtp
    protocol: tcp
    port: 1025
    exposed: true
supports:
  - type: https-origin
    endpoint: smtp
`),
		).toThrow(
			/https-origin endpoint \\?"smtp\\?" declares `protocol: tcp`.*HTTP-family listener.*Name the app's web endpoint instead/s,
		);
	});

	it("requires `endpoint:` on an https-origin entry", () => {
		expect(() =>
			readLaunch(`
name: app
image: app:1
provides:
  - name: web
    protocol: http
    port: 80
    exposed: true
requires:
  - type: https-origin
`),
		).toThrow(/must name the `provides` entry it fronts with `endpoint:`/);
	});

	it("rejects `endpoint:` on any other type", () => {
		expect(() =>
			readLaunch(`
name: app
image: app:1
requires:
  - type: postgres
    endpoint: web
`),
		).toThrow(/only meaningful on a `type: https-origin` entry/);
	});

	it("rejects an endpoint name that matches no provides entry", () => {
		expect(() =>
			readLaunch(`
name: app
image: app:1
provides:
  - name: api
    protocol: http
    port: 80
    exposed: true
requires:
  - type: https-origin
    endpoint: web
`),
		).toThrow(/matches no `provides` entry.*Named endpoints there: api/s);
	});

	it("rejects an endpoint that is not exposed", () => {
		expect(() =>
			readLaunch(`
name: app
image: app:1
provides:
  - name: web
    protocol: http
    port: 80
requires:
  - type: https-origin
    endpoint: web
`),
		).toThrow(/is not `exposed: true`/);
	});

	it("accepts the entry on the component that owns the endpoint", () => {
		const launch = readLaunch(`
name: hedgedoc-like
components:
  web:
    image: app:1
    provides:
      - name: ui
        protocol: http
        port: 3000
        exposed: true
    requires:
      - type: https-origin
        endpoint: ui
  worker:
    image: worker:1
`);
		expect(launch.components.web!.requires![0]!.endpoint).toBe("ui");
	});

	it("rejects the entry at the top level of a `components:` file", () => {
		expect(() =>
			readLaunch(`
name: hedgedoc-like
requires:
  - type: https-origin
    endpoint: ui
components:
  web:
    image: app:1
    provides:
      - name: ui
        protocol: http
        port: 3000
        exposed: true
  worker:
    image: worker:1
`),
		).toThrow(
			/must sit on the component that owns the endpoint, never at the top level/,
		);
	});

	it("rejects an entry naming an endpoint owned by a sibling component", () => {
		expect(() =>
			readLaunch(`
name: two-parts
components:
  web:
    image: app:1
    provides:
      - name: ui
        protocol: http
        port: 3000
        exposed: true
  worker:
    image: worker:1
    requires:
      - type: https-origin
        endpoint: ui
`),
		).toThrow(/matches no `provides` entry on worker/);
	});
});

describe("rule 3 — one per app", () => {
	it("rejects a second entry on another component", () => {
		expect(() =>
			readLaunch(`
name: two-origins
components:
  a:
    image: app:1
    provides:
      - name: ui
        protocol: http
        port: 3000
        exposed: true
    requires:
      - type: https-origin
        endpoint: ui
  b:
    image: app:1
    provides:
      - name: admin
        protocol: http
        port: 3001
        exposed: true
    supports:
      - type: https-origin
        endpoint: admin
`),
		).toThrow(/declares at most one `https-origin` entry, and this one declares 2/);
	});

	it("rejects two entries on one component", () => {
		expect(() =>
			readLaunch(`
name: app
image: app:1
provides:
  - name: web
    protocol: http
    port: 80
    exposed: true
  - name: bridge
    protocol: http
    port: 81
    exposed: true
requires:
  - type: https-origin
    endpoint: web
  - type: https-origin
    endpoint: bridge
`),
		).toThrow(/declares at most one `https-origin` entry/);
	});

	it("accepts an entry naming an endpoint that is not the first published one", () => {
		const launch = readLaunch(`
name: openclaw
image: ghcr.io/openclaw/openclaw:latest
provides:
  - name: gateway
    protocol: http
    port: 18789
    exposed: true
  - name: bridge
    protocol: http
    port: 18790
    exposed: true
requires:
  - type: https-origin
    endpoint: bridge
`);
		expect(launch.components.default!.requires![0]!.endpoint).toBe("bridge");
	});
});

describe("files that declare no https-origin entry are untouched", () => {
	it("still accepts a plain postgres requirement", () => {
		const launch = readLaunch(`
name: app
image: app:1
requires:
  - postgres
`);
		expect(launch.components.default!.requires![0]!.type).toBe("postgres");
		expect(launch.components.default!.requires![0]!.endpoint).toBeUndefined();
	});

	it("still accepts a tcp endpoint with no origin declared", () => {
		expect(() =>
			readLaunch(`
name: gitea
image: gitea/gitea:latest
provides:
  - name: ssh
    protocol: tcp
    port: 22
    exposed: true
`),
		).not.toThrow();
	});
});
