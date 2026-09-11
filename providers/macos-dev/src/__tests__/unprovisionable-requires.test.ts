import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { applyResourceTypeRefusals, refusedResourceTypes } from "../provider.js";
import { supportedResourceTypes } from "../resources/index.js";

/**
 * A `requires` entry naming a type this provider has no provisioner for is
 * REFUSED (PROVIDERS.md §10 item 5, D-next) — the ordinary case of the
 * `https-origin` refusal. This provider has no supplied-resource channel, so
 * nothing can satisfy such an entry from outside: provision or refuse are its
 * only conformant outcomes. Starting the component without the resource is
 * the silent success the rule forbids, so the outcome is what is pinned.
 */

const mk = (body: string) =>
	readLaunch(`version: launch/v1\nname: app\n${body}`);

const START = "commands:\n  start: run\n";

describe("refusedResourceTypes (D-next)", () => {
	it("refuses a component requiring a type with no provisioner", () => {
		const launch = mk(`${START}requires:\n  - type: kafka\n`);
		expect([...refusedResourceTypes(launch).keys()]).toEqual(["default"]);
		expect(refusedResourceTypes(launch).get("default")).toEqual(["kafka"]);
	});

	it("names a named entry as name plus type", () => {
		const launch = mk(`${START}requires:\n  - type: kafka\n    name: events\n`);
		expect(refusedResourceTypes(launch).get("default")).toEqual(['events (type "kafka")']);
	});

	it("lists every unprovisionable entry of the component", () => {
		const launch = mk(
			`${START}requires:\n  - type: kafka\n  - type: postgres\n  - type: clickhouse\n`,
		);
		expect(refusedResourceTypes(launch).get("default")).toEqual(["kafka", "clickhouse"]);
	});

	it("does not refuse a type it provisions", () => {
		for (const type of supportedResourceTypes()) {
			expect(refusedResourceTypes(mk(`${START}requires:\n  - type: ${type}\n`)).size).toBe(0);
		}
	});

	it("does not refuse a `supports:` entry — optional resources are not preconditions (D-8)", () => {
		expect(refusedResourceTypes(mk(`${START}supports:\n  - type: kafka\n`)).size).toBe(0);
	});

	it("leaves host-capability entries to their own refusal (rule 9)", () => {
		const launch = mk(`${START}requires:\n  - host: { container_runtime: docker }\n`);
		expect(refusedResourceTypes(launch).size).toBe(0);
	});

	it("leaves https-origin entries to their own refusal (D-60)", () => {
		const launch = mk(
			`provides:\n  - name: web\n    protocol: http\n    port: 8080\n    exposed: true\n${START}requires:\n  - type: https-origin\n    endpoint: web\n`,
		);
		expect(refusedResourceTypes(launch).size).toBe(0);
	});
});

describe("applyResourceTypeRefusals — the refusal is the removal", () => {
	it("removes the refused component from the run", () => {
		const launch = mk(`${START}requires:\n  - type: kafka\n`);
		expect(applyResourceTypeRefusals(launch)).toBe("none-left");
		expect(Object.keys(launch.components)).toEqual([]);
	});

	it("keeps the siblings that require only what this provider provisions", () => {
		const launch = readLaunch(`version: launch/v1
name: app
components:
  web:
    commands:
      start: run-web
    requires:
      - type: postgres
  worker:
    commands:
      start: run-worker
    requires:
      - type: kafka
`);
		expect(applyResourceTypeRefusals(launch)).toBe("ok");
		expect(Object.keys(launch.components)).toEqual(["web"]);
	});

	it("changes nothing for an app whose every type has a provisioner", () => {
		const launch = mk(`${START}requires:\n  - type: postgres\n  - type: redis\n`);
		expect(applyResourceTypeRefusals(launch)).toBe("ok");
		expect(Object.keys(launch.components)).toEqual(["default"]);
	});
});
