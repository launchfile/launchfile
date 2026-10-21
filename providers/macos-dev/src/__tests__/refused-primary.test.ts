/**
 * A refused declared primary resolves the empty `$app.*` address whatever
 * refused it (D-72, D-next): the refusal set is one function over the whole
 * file, `up` reads it before its refusals remove anything, and `env` and
 * `bootstrap` compute it again from the file and the inputs `up` recorded
 * (publication context, `--with-optional`), so the three verbs give one
 * answer.
 *
 * Every file here is the D-72 trigger shape with the supplied publication
 * URL satisfying the scheme: the primary's component is refused for a cause
 * other than D-60 rule 5, and a sibling with its own `exposed: true` HTTP
 * endpoint survives. Before this set existed the survivor was handed the
 * supplied URL — an origin nothing answers at (#588).
 */

import { REFUSED_PRIMARY_ADDRESS, readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import {
	computeAppEndpoints,
	computeAppProperties,
	printedPrimaryEndpoint,
} from "../env-writer.js";
import { declaredPrimary } from "../https-origin.js";
import { refusedComponents } from "../refusals.js";

const APP_URL = "https://split.example.com";
const ports = { web: 13000, admin: 14000 };

const ADMIN = `  admin:
    runtime: node
    provides:
      - name: panel
        protocol: http
        port: 4000
        exposed: true
    commands:
      start: node admin.js
`;

/** `web` declares the primary; `extra` is what refuses it. */
function split(
	extra: string,
	key: "requires" | "supports" = "requires",
	listener = "",
): string {
	return `version: launch/v1
name: split
components:
  web:
    runtime: node
    provides:
      - name: ui
        protocol: http
        port: 3000
        exposed: true
${listener}    ${key}:
      - type: https-origin
        endpoint: ui
${extra}
    commands:
      start: node web.js
${ADMIN}`;
}

const CAUSES: {
	cause: string;
	file: string;
	appUrl?: string;
	withOptional?: boolean;
}[] = [
	{
		cause: "host capability (D-44)",
		file: split("      - host: { container_runtime: docker }"),
		appUrl: APP_URL,
	},
	{
		cause: "https-origin scheme (D-60 rule 5)",
		file: split(""),
		appUrl: "http://split.example.com",
	},
	{
		cause: "certificate (D-61 rule 5)",
		file: split(
			`    supports:
      - name: server-cert
        type: certificate
        set_env:
          CERT_FILE: $cert_file
          KEY_FILE: $key_file`,
			"requires",
			"        tls: server-cert\n",
		),
		appUrl: APP_URL,
		withOptional: true,
	},
	{
		cause: "unprovisionable type (D-64)",
		file: split("      - type: kafka"),
		appUrl: APP_URL,
	},
	{
		cause: "uncovered use (D-65 rule 3)",
		file: split("      - type: redis\n        uses: [nosuchuse]"),
		appUrl: APP_URL,
	},
];

describe.each(CAUSES)(
	"the primary refused for $cause",
	({ file, appUrl, withOptional }) => {
		const launch = readLaunch(file);
		const inputs = { appUrl, withOptional };

		it("is in the refusal set, and the survivor is not", () => {
			expect([...refusedComponents(launch, inputs)]).toEqual(["web"]);
		});

		it("hands the survivor the empty address as `up` reads it, never the supplied URL", () => {
			const primary = declaredPrimary(
				launch,
				refusedComponents(launch, inputs),
			);
			expect(primary).toEqual({ component: "web", refused: true });
			expect(computeAppProperties(launch, ports, appUrl, primary)).toEqual({
				name: "split",
				...REFUSED_PRIMARY_ADDRESS,
			});
			expect(
				printedPrimaryEndpoint(launch, ports, appUrl, primary),
			).toBeUndefined();
		});

		it("$app.endpoints.<primary>.* reads the same empty answer (D-63 rules 2 and 4)", () => {
			const endpoints = computeAppEndpoints(launch);
			expect(endpoints.ui?.url).toBe("");
			expect(endpoints.ui?.tls).toBe("");
			expect(endpoints.panel?.url).toBe("");
		});
	},
);

describe("env and bootstrap read the file whole and decide the same set", () => {
	it.each(CAUSES.filter((c) => !c.withOptional))(
		"$cause: the default primary reads the refusal set from the file and the recorded URL",
		({ file, appUrl }) => {
			const launch = readLaunch(file);
			expect(computeAppProperties(launch, ports, appUrl)).toEqual({
				name: "split",
				...REFUSED_PRIMARY_ADDRESS,
			});
			expect(printedPrimaryEndpoint(launch, ports, appUrl)).toBeUndefined();
		},
	);

	it("a certificate refusal turns on `--with-optional`, so the set reads the flag `up` recorded", () => {
		const cert = CAUSES.find((c) => c.withOptional);
		if (cert === undefined) throw new Error("certificate cause missing");
		const launch = readLaunch(cert.file);
		expect([
			...refusedComponents(launch, { appUrl: APP_URL, withOptional: true }),
		]).toEqual(["web"]);
		expect(
			refusedComponents(launch, { appUrl: APP_URL, withOptional: false }).size,
		).toBe(0);
	});
});

describe("the key does not matter (D-60 rule 3)", () => {
	it("a supports: primary refused for a non-scheme cause resolves the empty address too", () => {
		const launch = readLaunch(
			split("    requires:\n      - type: kafka", "supports"),
		);
		expect([...refusedComponents(launch, { appUrl: APP_URL })]).toEqual([
			"web",
		]);
		expect(computeAppProperties(launch, ports, APP_URL)).toEqual({
			name: "split",
			...REFUSED_PRIMARY_ADDRESS,
		});
	});

	it("an unsatisfied supports: entry on its own refuses nothing — the optional mood (D-60 rule 6)", () => {
		const launch = readLaunch(split("", "supports"));
		expect(refusedComponents(launch, {}).size).toBe(0);
		expect(computeAppProperties(launch, ports).url).toBe(
			"http://localhost:13000",
		);
	});
});

describe("the refusal set's fence", () => {
	it("a component outside the start-set is not graded: the set reads the file it is given", () => {
		const launch = readLaunch(split("      - type: kafka"));
		delete launch.components.web;
		expect(refusedComponents(launch, { appUrl: APP_URL }).size).toBe(0);
	});
});
