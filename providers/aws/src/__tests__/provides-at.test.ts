/**
 * `at:` on a `provides` entry on `@launchfile/aws` (D-68 rule 5): a provider
 * provisions every declared name or refuses the component. `translate` has no
 * launch at which to refuse, and this probe emits no DNS record, host-header
 * rule or certificate — so each declaring entry is reported unmapped rather
 * than silently dropped (PROVIDERS.md §10 items 5 and 8).
 */

import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { translate } from "../translate.js";

function tf(yaml: string) {
	return translate(readLaunch(yaml));
}

const APP = `
version: launch/v1
name: my-app
runtime: node
commands:
  start: "node server.js"
provides:
  - name: web
    protocol: http
    port: 3000
    exposed: true
`;

const withAt = (at: string) => `${APP}    at: ${at}\n`;

const atGaps = (yaml: string) =>
	tf(yaml).conformance.gaps.filter((g) => g.field === "provides.at");

describe("translate — `at:` on a provides entry (D-68 rule 5)", () => {
	it("reports the entry unmapped, as a workaround gap on its component", () => {
		const gaps = atGaps(withAt('["@", dash, "*"]'));
		expect(gaps).toHaveLength(1);
		expect(gaps[0]!.severity).toBe("workaround");
		expect(gaps[0]!.component).toBe("default");
	});

	it("names the entry and every declared value", () => {
		const [gap] = atGaps(withAt('["@", dash, "*"]'));
		expect(gap!.reason).toContain('`provides` entry "web" on default');
		expect(gap!.reason).toContain("`@`, `dash`, `*`");
	});

	it("says what this probe emits and suggests what would cover the names", () => {
		const [gap] = atGaps(withAt('["@", dash]'));
		expect(gap!.reason).toBe(
			'`provides` entry "web" on default declares the host names `@`, `dash` relative to ' +
				"the app host, and this probe routes no host names — it emits one ALB default " +
				"action per listener and no DNS record, host-header rule or certificate",
		);
		expect(gap!.suggestion).toContain("aws_lb_listener_rule");
	});

	it("emits nothing to make the declaration look covered", () => {
		const { hcl } = tf(withAt('["@", dash, "*"]'));
		expect(hcl).not.toContain("aws_route53_record");
		expect(hcl).not.toContain("aws_lb_listener_rule");
		expect(hcl).not.toContain("aws_acm_certificate");
	});

	it("reports one gap per declaring entry", () => {
		const gaps = atGaps(`${withAt('"@"')}  - name: admin
    protocol: http
    port: 9090
    exposed: true
    at: ["*", "*.*"]
`);
		expect(gaps.map((g) => g.reason.split(" declares ")[0])).toEqual([
			'`provides` entry "web" on default',
			'`provides` entry "admin" on default',
		]);
		expect(gaps[1]!.reason).toContain("`*`, `*.*`");
	});
});

describe("translate — a file that declares no `at:`", () => {
	it("reports nothing about `at:`", () => {
		expect(atGaps(APP)).toEqual([]);
	});

	it("translates to the same HCL and ledger as the declaring file, less the gap", () => {
		const plain = tf(APP);
		const declared = tf(withAt('["@", dash, "*"]'));
		expect(declared.hcl).toBe(plain.hcl);
		expect(declared.conformance.mapped).toEqual(plain.conformance.mapped);
		expect(declared.conformance.ignored).toEqual(plain.conformance.ignored);
		expect(
			declared.conformance.gaps.filter((g) => g.field !== "provides.at"),
		).toEqual(plain.conformance.gaps);
	});
});
