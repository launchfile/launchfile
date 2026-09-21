import { readLaunch } from "@launchfile/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAtRefusals, refusedAtDeclarations } from "../provider.js";

/**
 * `at:` on a `provides` entry (D-next rule 5): a provider provisions every
 * declared name or refuses the component before launch. This provider starts
 * processes on local ports and routes no host names, and a publication URL
 * states the app host's address, not which `at:` values an orchestrator
 * covers — so every declaring component is refused, and the refusal takes no
 * publication URL at all.
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
    commands:
      start: run
  worker:
    commands:
      start: work
`;

const captureStderr = (): string[] => {
	const errors: string[] = [];
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	});
	return errors;
};

describe("refusedAtDeclarations (D-next rule 5)", () => {
	it("refuses a component whose `provides` entry declares `at:`", () => {
		const refused = refusedAtDeclarations(mk(web('["@", dash, "*"]')));
		expect([...refused.keys()]).toEqual(["default"]);
		expect(refused.get("default")).toEqual([
			{ component: "default", index: 0, name: "web", values: ["@", "dash", "*"] },
		]);
	});

	it("refuses the scalar form, which parses to a one-value list", () => {
		const refused = refusedAtDeclarations(mk(web('"@"')));
		expect(refused.get("default")?.[0]?.values).toEqual(["@"]);
	});

	it("collects every declaring entry of one component", () => {
		const launch = mk(`provides:
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
commands:
  start: run
`);
		expect(refusedAtDeclarations(launch).get("default")?.map((d) => d.name)).toEqual([
			"web",
			"admin",
		]);
	});

	it("ignores an app that declares no `at:`", () => {
		expect(refusedAtDeclarations(mk(PLAIN)).size).toBe(0);
	});
});

describe("applyAtRefusals — the refusal is the removal", () => {
	afterEach(() => vi.restoreAllMocks());

	it("removes the refused component from the run", () => {
		captureStderr();
		const launch = mk(web('["@", dash, "*"]'));
		expect(applyAtRefusals(launch)).toBe("none-left");
		expect(Object.keys(launch.components)).toEqual([]);
	});

	it("names the entry and every declared value on stderr", () => {
		const errors = captureStderr();
		applyAtRefusals(mk(web('["@", dash, "*"]')));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('`provides` entry "web" on default: "@", "dash", "*"');
	});

	it("says what this provider does and why nothing can cover the values yet", () => {
		const errors = captureStderr();
		applyAtRefusals(mk(web('["@", dash]')));
		expect(errors).toEqual([
			"  Refused: default declares `at:` host names this provider cannot cover " +
				'(`provides` entry "web" on default: "@", "dash") — this provider starts processes ' +
				"on local ports and routes no host names, and an orchestrator-supplied statement of " +
				"the values it covers is not available yet (#543); use a provider that provisions " +
				"the names — component not started",
		]);
	});

	it("names an unnamed entry by position", () => {
		const errors = captureStderr();
		applyAtRefusals(
			mk(`provides:
  - protocol: http
    port: 8080
    exposed: true
    at: dash
commands:
  start: run
`),
		);
		expect(errors[0]).toContain('`provides` entry #1 (unnamed) on default: "dash"');
	});

	it("keeps the components that declare no `at:`", () => {
		const errors = captureStderr();
		const launch = readLaunch(TWO);
		expect(applyAtRefusals(launch)).toBe("ok");
		expect(Object.keys(launch.components)).toEqual(["worker"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/^ {2}Refused: web /);
	});

	it("leaves an app that declares no `at:` untouched and silent", () => {
		const errors = captureStderr();
		const launch = mk(PLAIN);
		const before = structuredClone(launch);
		expect(applyAtRefusals(launch)).toBe("ok");
		expect(launch).toEqual(before);
		expect(errors).toEqual([]);
	});
});
