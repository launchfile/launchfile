import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { applyHttpsOriginRefusals, refusedHttpsOrigins } from "../provider.js";

/**
 * This provider has no edge and no orchestrator-facing publication channel
 * (#294), so it can neither provision an `https-origin` nor accept a supplied
 * one: it refuses (D-next rule 5, PROVIDERS.md §10 item 5). Refusing is
 * conformant; starting the component anyway is the silent success the type
 * exists to remove, so only an outcome assertion pins it.
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

describe("refusedHttpsOrigins (D-next rule 5)", () => {
	it("refuses a component with a required https-origin", () => {
		const launch = mk(`${WEB}requires:\n  - type: https-origin\n    endpoint: web\n`);
		expect([...refusedHttpsOrigins(launch).keys()]).toEqual(["default"]);
		expect(refusedHttpsOrigins(launch).get("default")).toEqual([
			'https-origin (endpoint "web")',
		]);
	});

	it("does not refuse a `supports:` entry — the component runs degraded", () => {
		const launch = mk(`${WEB}supports:\n  - type: https-origin\n    endpoint: web\n`);
		expect(refusedHttpsOrigins(launch).size).toBe(0);
	});

	it("ignores apps that declare no https-origin entry", () => {
		expect(refusedHttpsOrigins(mk(`${WEB}requires:\n  - postgres\n`)).size).toBe(0);
	});
});

describe("applyHttpsOriginRefusals — the refusal is the removal", () => {
	it("removes the refused component from the run", () => {
		const launch = mk(`${WEB}requires:\n  - type: https-origin\n    endpoint: web\n`);
		expect(applyHttpsOriginRefusals(launch)).toBe("none-left");
		expect(Object.keys(launch.components)).toEqual([]);
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
