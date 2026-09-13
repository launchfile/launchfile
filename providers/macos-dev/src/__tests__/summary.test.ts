/**
 * The address `up` and `status` print (#386, D-58): the supplied publication
 * URL on the primary component, as stored, and this provider's own
 * `http://localhost:<port>` on every other — and on every component when no
 * URL is supplied. One definition, `componentAddress`, feeds both printouts,
 * the shape `@launchfile/docker` tests through `summaryLines`.
 */

import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { computeAppProperties, primaryComponent } from "../env-writer.js";
import { componentAddress, statusLines, summaryLines } from "../provider.js";

const ports = { web: 31245, api: 31246 };
const publication = { appUrl: "https://notes.example.com", primaryEndpoint: "web" };

describe("componentAddress", () => {
	it("prints the supplied URL for the primary component, as stored", () => {
		expect(componentAddress("web", 31245, publication)).toBe("https://notes.example.com");
		// A non-root path survives verbatim (D-58 rule 2) — nothing re-normalizes here.
		expect(
			componentAddress("web", 31245, { appUrl: "https://notes.example.com/app", primaryEndpoint: "web" }),
		).toBe("https://notes.example.com/app");
	});

	it("prints localhost for every other component (D-58 rule 4)", () => {
		expect(componentAddress("api", 31246, publication)).toBe("http://localhost:31246");
	});

	it("prints localhost with no URL, with a URL but no recorded primary, and with no state", () => {
		expect(componentAddress("web", 31245)).toBe("http://localhost:31245");
		expect(componentAddress("web", 31245, {})).toBe("http://localhost:31245");
		expect(componentAddress("web", 31245, { primaryEndpoint: "web" })).toBe("http://localhost:31245");
		// A state file from before the primary key was recorded: URL set, key unknown.
		expect(componentAddress("web", 31245, { appUrl: "https://notes.example.com" })).toBe(
			"http://localhost:31245",
		);
	});
});

describe("summaryLines", () => {
	it("shows the URL on the primary and localhost on the rest", () => {
		expect(summaryLines("notes", ports, publication)).toEqual([
			"  web is running at https://notes.example.com",
			"  api is running at http://localhost:31246",
		]);
	});

	it("is byte-identical to today without a URL", () => {
		const plain = summaryLines("notes", ports);
		expect(plain).toEqual([
			"  web is running at http://localhost:31245",
			"  api is running at http://localhost:31246",
		]);
		expect(summaryLines("notes", ports, {})).toEqual(plain);
	});

	it("labels the default component with the app name", () => {
		expect(summaryLines("notes", { default: 31245 }, { ...publication, primaryEndpoint: "default" })).toEqual([
			"  notes is running at https://notes.example.com",
		]);
		expect(summaryLines("notes", { default: 31245 })).toEqual(["  notes is running at http://localhost:31245"]);
	});
});

describe("statusLines", () => {
	it("places the URL the same way", () => {
		expect(statusLines(ports, publication)).toEqual([
			"  web: https://notes.example.com",
			"  api: http://localhost:31246",
		]);
	});

	it("is byte-identical to today without a URL", () => {
		expect(statusLines(ports)).toEqual(["  web: http://localhost:31245", "  api: http://localhost:31246"]);
		expect(statusLines(ports, {})).toEqual(statusLines(ports));
	});
});

describe("primaryComponent — the key the URL asserts", () => {
	const TWO = `version: launch/v1
name: two
components:
  api:
    image: api-like
    provides:
      - port: 4000
        protocol: http
  web:
    image: web-like
    provides:
      - port: 3000
        protocol: http
        exposed: true
`;

	const DECLARED = `version: launch/v1
name: declared
components:
  web:
    image: web-like
    provides:
      - name: ui
        port: 3000
        protocol: http
        exposed: true
  bridge:
    image: bridge-like
    provides:
      - name: hook
        port: 3001
        protocol: http
        exposed: true
    supports:
      - type: https-origin
        endpoint: hook
`;

	it("is the first component with an exposed endpoint and a port", () => {
		expect(primaryComponent(readLaunch(TWO), { api: 4000, web: 3000 })).toBe("web");
	});

	it("is the component a declared https-origin names (D-60 rule 3)", () => {
		expect(primaryComponent(readLaunch(DECLARED), { web: 3000, bridge: 3001 })).toBe("bridge");
	});

	it("is undefined when nothing is published", () => {
		expect(primaryComponent(readLaunch(TWO), { api: 4000 })).toBeUndefined();
	});

	it("is the component whose port $app.url reads", () => {
		const launch = readLaunch(TWO);
		const p: Record<string, number> = { api: 4000, web: 3000 };
		expect(computeAppProperties(launch, p).url).toBe(`http://localhost:${p[primaryComponent(launch, p)!]}`);
	});
});
