import { readLaunch } from "@launchfile/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	declaredPrimaryComponent,
	httpsOriginSatisfied,
	httpsOriginShortfall,
	wireHttpsOrigins,
} from "../https-origin.js";
import { applyHttpsOriginRefusals, refusedHttpsOrigins } from "../provider.js";
import type { ResourceProperties } from "../resources/types.js";

/**
 * This provider has no edge of its own, so it cannot provision an
 * `https-origin`. It can accept one through the publication-context channel
 * (`appUrl`, D-58) — which for this type IS the supplied-resource channel
 * (D-60 rule 5, PROVIDERS.md §7) — when the scheme is https; then the entry is
 * satisfied and its `url` is wired. With no URL, or one whose scheme is not
 * https, a required entry refuses the component (PROVIDERS.md §10 item 5).
 * Starting the component anyway is the silent success the type exists to
 * remove, so only an outcome assertion pins it.
 */

const mk = (body: string) =>
	readLaunch(`version: launch/v1\nname: app\n${body}`);

const WEB = `provides:
  - name: web
    protocol: http
    port: 8080
    exposed: true
commands:
  start: run
`;

const REQUIRED = mk(
	`${WEB}requires:\n  - type: https-origin\n    endpoint: web\n`,
);

describe("httpsOriginSatisfied (D-60 rule 5 — syntactic scheme check)", () => {
	it("is satisfied by an https publication URL", () => {
		expect(httpsOriginSatisfied("https://vw.example.com")).toBe(true);
	});

	it("is not satisfied by an http URL, nor by nothing at all", () => {
		expect(httpsOriginSatisfied("http://vw.example.com")).toBe(false);
		expect(httpsOriginSatisfied(undefined)).toBe(false);
	});
});

describe("refusedHttpsOrigins (D-60 rule 5)", () => {
	it("refuses a required entry when no publication URL was supplied, saying so", () => {
		const refused = refusedHttpsOrigins(REQUIRED);
		expect([...refused.keys()]).toEqual(["default"]);
		expect(refused.get("default")).toEqual([
			'https-origin (endpoint "web"): no publication URL was supplied, and this provider has no edge of its own',
		]);
	});

	it("refuses a required entry when the supplied URL is not https, naming the scheme", () => {
		const refused = refusedHttpsOrigins(REQUIRED, "http://vw.example.com");
		expect(refused.get("default")).toEqual([
			'https-origin (endpoint "web"): the supplied publication URL\'s scheme is "http", not https',
		]);
	});

	it("satisfies a required entry from an https URL — nothing is refused", () => {
		expect(refusedHttpsOrigins(REQUIRED, "https://vw.example.com").size).toBe(
			0,
		);
	});

	it("does not refuse a `supports:` entry — the component runs degraded", () => {
		const launch = mk(
			`${WEB}supports:\n  - type: https-origin\n    endpoint: web\n`,
		);
		expect(refusedHttpsOrigins(launch).size).toBe(0);
	});

	it("ignores apps that declare no https-origin entry", () => {
		expect(
			refusedHttpsOrigins(mk(`${WEB}requires:\n  - postgres\n`)).size,
		).toBe(0);
	});
});

describe("applyHttpsOriginRefusals — the refusal is the removal", () => {
	afterEach(() => vi.restoreAllMocks());

	it("removes the refused component from the run and names the shortfall", () => {
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		});
		const launch = mk(
			`${WEB}requires:\n  - type: https-origin\n    endpoint: web\n`,
		);
		expect(applyHttpsOriginRefusals(launch, "http://vw.example.com")).toBe(
			"none-left",
		);
		expect(Object.keys(launch.components)).toEqual([]);
		expect(errors.join("\n")).toContain('scheme is "http", not https');
		expect(errors.join("\n")).not.toContain("no publication channel");
	});

	it("keeps the component when an https URL satisfies the entry", () => {
		const launch = mk(
			`${WEB}requires:\n  - type: https-origin\n    endpoint: web\n`,
		);
		expect(applyHttpsOriginRefusals(launch, "https://vw.example.com")).toBe(
			"ok",
		);
		expect(Object.keys(launch.components)).toEqual(["default"]);
	});

	it("keeps the components that declare nothing of the kind", () => {
		const launch = readLaunch(`version: launch/v1
name: app
components:
  web:
    provides:
      - name: ui
        protocol: http
        port: 3000
        exposed: true
    commands:
      start: run-web
    requires:
      - type: https-origin
        endpoint: ui
  worker:
    commands:
      start: run-worker
`);
		expect(applyHttpsOriginRefusals(launch)).toBe("ok");
		expect(Object.keys(launch.components)).toEqual(["worker"]);
	});
});

describe("httpsOriginShortfall — docker's two reasons, verbatim (P-5)", () => {
	const entry = { type: "https-origin", name: "origin", endpoint: "web" };

	it("names the missing URL", () => {
		expect(httpsOriginShortfall(entry, undefined)).toBe(
			'origin (endpoint "web"): no publication URL was supplied, and this provider has no edge of its own',
		);
	});

	it("names the wrong scheme", () => {
		expect(httpsOriginShortfall(entry, "http://vw.example.com")).toBe(
			'origin (endpoint "web"): the supplied publication URL\'s scheme is "http", not https',
		);
	});
});

describe("wireHttpsOrigins — one registered property, `url` (D-60 rule 4)", () => {
	const optional = mk(
		`${WEB}supports:\n  - name: alt\n    type: https-origin\n    endpoint: web\n`,
	);

	it("registers a required entry, keyed by type, holding $app.url", () => {
		const resourceMap: Record<string, ResourceProperties> = {};
		wireHttpsOrigins(REQUIRED, resourceMap, "https://vw.example.com");
		expect(resourceMap).toEqual({
			"https-origin": { url: "https://vw.example.com" },
		});
	});

	it("registers a supports entry the same way, keyed by its name", () => {
		const resourceMap: Record<string, ResourceProperties> = {};
		wireHttpsOrigins(optional, resourceMap, "https://vw.example.com");
		expect(resourceMap).toEqual({ alt: { url: "https://vw.example.com" } });
	});

	it("registers nothing when the URL does not satisfy the type", () => {
		const resourceMap: Record<string, ResourceProperties> = {};
		wireHttpsOrigins(REQUIRED, resourceMap, "http://vw.example.com");
		wireHttpsOrigins(optional, resourceMap, undefined);
		expect(resourceMap).toEqual({});
	});
});

describe("declaredPrimaryComponent (D-60 rule 3)", () => {
	it("names the component the entry sits on, fulfilled or not", () => {
		expect(declaredPrimaryComponent(REQUIRED)).toBe("default");
		expect(
			declaredPrimaryComponent(
				mk(`${WEB}supports:\n  - type: https-origin\n    endpoint: web\n`),
			),
		).toBe("default");
	});

	it("is undefined when no entry is declared", () => {
		expect(declaredPrimaryComponent(mk(WEB))).toBeUndefined();
	});
});
