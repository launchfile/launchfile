import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { atReports } from "../provider.js";

/**
 * `at:` on a `provides` entry (D-68 rule 5). This provider starts each process
 * on a local port with nothing in front that routes by host name, so every
 * request reaches the listener with its `Host` intact and only name resolution
 * is left to the operator. It launches the component and reports the names —
 * never a silent launch, never a refusal.
 */

const mk = (body: string) =>
	readLaunch(`version: launch/v1\nname: app\n${body}`);

const web = (at: string) => `provides:
  - name: web
    protocol: http
    port: 8080
    exposed: true
    at: ${at}
commands:
  start: run
`;

const PLAIN = `provides:
  - name: web
    protocol: http
    port: 8080
    exposed: true
commands:
  start: run
`;

const TWO = `version: launch/v1
name: app
components:
  web:
    provides:
      - name: web
        protocol: http
        port: 8080
        exposed: true
        at: ["@", dash, "*"]
      - name: admin
        protocol: http
        port: 9090
        exposed: true
        at: "*.*"
    commands:
      start: run
  worker:
    commands:
      start: work
`;

describe("atReports", () => {
	it("names the entry and every name it answers at, under localhost", () => {
		const [report] = atReports(mk(web('["@", dash, "*", "*.*"]')));
		expect(report).toContain('`provides` entry "web" on default');
		expect(report).toContain(
			"answers at localhost, dash.localhost, *.localhost, *.*.localhost",
		);
	});

	it("says where requests arrive and what the operator can do", () => {
		const [report] = atReports(mk(web('["@", dash]')), { default: 18080 });
		expect(report).toBe(
			'`provides` entry "web" on default answers at localhost, dash.localhost (`at:`, D-68) — ' +
				"this provider starts the process on a local port and sets up no host names. Every " +
				"request that reaches localhost:18080 reaches the listener with its `Host` intact, so " +
				"map each name that does not resolve to this machine (hosts file or DNS), or use a " +
				"provider that routes host names",
		);
	});

	it("does not name a port it does not know", () => {
		const [report] = atReports(mk(web("dash")));
		expect(report).toContain("reaches the component's local port reaches");
		expect(report).not.toContain("localhost:");
	});

	it("reports the scalar form, which parses to a one-value list", () => {
		const [report] = atReports(mk(web("dash")));
		expect(report).toContain("answers at dash.localhost (");
	});

	it("reports each declaring entry on its own, and no other component", () => {
		const reports = atReports(readLaunch(TWO), { web: 18080, worker: 18081 });
		expect(reports).toHaveLength(2);
		expect(reports[0]).toContain(
			'entry "web" on web answers at localhost, dash.localhost',
		);
		expect(reports[1]).toContain('entry "admin" on web answers at *.*.localhost (');
		expect(reports.join("\n")).not.toContain("worker");
	});

	it("names an unnamed entry by position", () => {
		const [report] = atReports(
			mk(`provides:
  - protocol: http
    port: 8080
    exposed: true
    at: dash
commands:
  start: run
`),
		);
		expect(report).toContain("`provides` entry #1 (unnamed) on default");
	});

	it("reports the names under the supplied host, and whose they are to route", () => {
		const [report] = atReports(
			mk(web('["@", dash, "*"]')),
			{ default: 18080 },
			"https://app.example.com",
		);
		expect(report).toContain(
			"answers at app.example.com, dash.app.example.com, *.app.example.com",
		);
		expect(report).toContain(
			"the supplied publication URL (https://app.example.com) says nothing about them",
		);
		expect(report).not.toContain("localhost");
	});

	it("is empty for an app that declares no `at:`", () => {
		expect(atReports(mk(PLAIN), { default: 18080 })).toEqual([]);
	});

	it("leaves the launch untouched: no component is removed", () => {
		const launch = readLaunch(TWO);
		atReports(launch);
		expect(Object.keys(launch.components)).toEqual(["web", "worker"]);
	});
});
