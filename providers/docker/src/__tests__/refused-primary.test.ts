/**
 * A refused declared primary resolves the empty `$app.*` address whatever
 * refused it (D-72, D-next): the refusal set is one function, decided once
 * from the inputs `up` decides on, and `$app.*`, the compose environment,
 * `bootstrap` and `release` all read it.
 *
 * Every file here is the D-72 trigger shape with the supplied publication
 * URL satisfying the scheme: the primary's component is refused for a cause
 * other than D-60 rule 5, and a sibling with its own `exposed: true` HTTP
 * endpoint survives. Before this set existed the survivor was handed the
 * supplied URL — an origin nothing answers at (#588).
 */

import { REFUSED_PRIMARY_ADDRESS, readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { computeAppContext } from "../app-url.js";
import { planBootstraps } from "../bootstrap.js";
import {
	type ComposeOpts,
	launchToCompose,
	provisionedTypes,
} from "../compose-generator.js";
import { PROVISIONED_TYPES, refusedComponents } from "../refusals.js";
import { planReleases } from "../release.js";

const APP_URL = "https://split.example.com";

/** The survivor reads every `$app.*` property and both endpoints' urls. */
const ADMIN = `  admin:
    image: admin:1
    provides:
      - name: panel
        protocol: http
        port: 4000
        exposed: true
    env:
      PUBLIC_URL:
        default: $app.url
      APP_HOST:
        default: $app.host
      APP_PORT:
        default: $app.port
      APP_SCHEME:
        default: $app.scheme
      APP_AUTHORITY:
        default: $app.authority
      USE_TLS:
        default: $app.tls
      APP_NAME:
        default: $app.name
      PRIMARY_URL:
        default: $app.endpoints.ui.url
      OWN_URL:
        default: $app.endpoints.panel.url
    commands:
      bootstrap: echo $app.url $app.tls
      release: echo $app.url $app.tls
`;

/** `web` declares the primary; `extra` is what refuses it. */
function split(
	extra: string,
	key: "requires" | "supports" = "requires",
): string {
	return `
name: split
components:
  web:
    image: web:1
    provides:
      - name: ui
        protocol: http
        port: 3000
        exposed: true
    ${key}:
      - type: https-origin
        endpoint: ui
${extra}
${ADMIN}`;
}

const HOST_CAPABILITY = split(`      - host: { container_runtime: docker }`);
const CERTIFICATE = `
name: split
components:
  web:
    image: web:1
    provides:
      - name: ui
        protocol: http
        port: 3000
        exposed: true
        tls: server-cert
    requires:
      - type: https-origin
        endpoint: ui
    supports:
      - name: server-cert
        type: certificate
        set_env:
          CERT_FILE: $cert_file
          KEY_FILE: $key_file
${ADMIN}`;
const UNPROVISIONABLE = split(`      - type: sqlite`);
const UNCOVERED_USE = split(`      - type: redis
        uses: [nosuchuse]`);
const SUPPORTS_UNPROVISIONABLE = `
name: split
components:
  web:
    image: web:1
    provides:
      - name: ui
        protocol: http
        port: 3000
        exposed: true
    supports:
      - type: https-origin
        endpoint: ui
    requires:
      - type: sqlite
${ADMIN}`;

/** A certificate selected but unsatisfied: `key_file` missing (D-61 rule 5). */
const HALF_CERT: ComposeOpts["resources"] = {
	"server-cert": { properties: { cert_file: "/run/secrets/tls/web.crt" } },
};

const EMPTY = {
	PUBLIC_URL: "",
	APP_HOST: "",
	APP_PORT: "",
	APP_SCHEME: "",
	APP_AUTHORITY: "",
	USE_TLS: "false",
	APP_NAME: "split",
	PRIMARY_URL: "",
};

const hostPorts = { web: 13000, admin: 14000 };

function services(
	yaml: string,
): Record<string, { environment?: Record<string, string> }> {
	return (
		parse(yaml) as {
			services: Record<string, { environment?: Record<string, string> }>;
		}
	).services;
}

/** One cause: the file, the refusal's distinguishing text, and the `up` inputs. */
const CAUSES: {
	cause: string;
	file: string;
	names: string;
	resources?: ComposeOpts["resources"];
}[] = [
	{
		cause: "host capability (D-44)",
		file: HOST_CAPABILITY,
		names: "container_runtime=docker",
	},
	{
		cause: "https-origin scheme (D-60 rule 5)",
		file: split(""),
		names: 'scheme is "http", not https',
	},
	{
		cause: "certificate (D-61 rule 5)",
		file: CERTIFICATE,
		names: "server-cert",
		resources: HALF_CERT,
	},
	{
		cause: "unprovisionable type (D-64)",
		file: UNPROVISIONABLE,
		names: "(sqlite)",
	},
	{
		cause: "uncovered use (D-65 rule 3)",
		file: UNCOVERED_USE,
		names: "nosuchuse",
	},
];

describe.each(CAUSES)(
	"the primary refused for $cause",
	({ cause, file, names, resources }) => {
		// The scheme cause is the one D-72 already covered; every other cause
		// runs under a URL that satisfies the scheme, so the supplied URL is the
		// value that must not leak.
		const appUrl = cause.startsWith("https-origin")
			? "http://split.example.com"
			: APP_URL;
		const launch = readLaunch(file);
		const inputs = { appUrl, resources };

		it("is in the refusal set, with a message naming the component and the entry", () => {
			const refusals = refusedComponents(launch, inputs);
			expect([...refusals.keys()]).toEqual(["web"]);
			expect(refusals.get("web")).toMatch(/^refused: web /);
			expect(refusals.get("web")).toContain(names);
		});

		it("hands the survivor the empty address, never the supplied URL", () => {
			const result = launchToCompose(launch, { hostPorts, appUrl, resources });
			const svc = services(result.yaml);
			expect(svc["split-web"]).toBeUndefined();
			expect(svc["split-admin"]?.environment).toMatchObject(EMPTY);
			// Under a supplied publication context D-58 rule 4's fence is unchanged:
			// the survivor's own named endpoint resolves "" there too.
			expect(svc["split-admin"]?.environment?.OWN_URL).toBe("");
			expect(result.warnings.filter((w) => w.startsWith("refused:"))).toEqual([
				refusedComponents(launch, inputs).get("web"),
			]);
		});

		it("without a publication context the survivor keeps its own published address", () => {
			const result = launchToCompose(launch, { hostPorts, resources });
			const env = services(result.yaml)["split-admin"]?.environment;
			expect(env).toMatchObject(EMPTY);
			expect(env?.OWN_URL).toBe("http://localhost:14000");
		});

		it("$app.* and $app.endpoints.<primary>.* read the same empty answer (D-63 rule 2)", () => {
			const { app, appEndpoints } = computeAppContext(
				launch,
				hostPorts,
				appUrl,
				undefined,
				refusedComponents(launch, inputs),
			);
			expect(app).toEqual({ name: "split", ...REFUSED_PRIMARY_ADDRESS });
			expect(appEndpoints.ui).toEqual(REFUSED_PRIMARY_ADDRESS);
			expect(appEndpoints.panel?.url).toBe("");
			expect(
				computeAppContext(
					launch,
					hostPorts,
					undefined,
					undefined,
					refusedComponents(launch, inputs),
				).appEndpoints.panel?.url,
			).toBe("http://localhost:14000");
		});

		it("bootstrap and release decide the same set from the same inputs", () => {
			const result = launchToCompose(launch, { hostPorts, appUrl, resources });
			const bootstrap = planBootstraps(launch, {
				hostPorts,
				secrets: {},
				appUrl,
				resources,
			});
			const release = planReleases(launch, {
				services: result.services,
				hostPorts,
				secrets: {},
				appUrl,
				resources,
			});
			expect(bootstrap.map((b) => b.component)).toEqual(["admin"]);
			expect(bootstrap[0]?.command).toBe("echo  false");
			expect(release.map((r) => r.component)).toEqual(["admin"]);
			expect(release[0]?.command).toBe("echo  false");
		});
	},
);

describe("the key does not matter (D-60 rule 3)", () => {
	it("a supports: primary refused for a non-scheme cause resolves the empty address too", () => {
		const launch = readLaunch(SUPPORTS_UNPROVISIONABLE);
		const result = launchToCompose(launch, { hostPorts, appUrl: APP_URL });
		const svc = services(result.yaml);
		expect(svc["split-web"]).toBeUndefined();
		expect(svc["split-admin"]?.environment).toMatchObject(EMPTY);
		expect(svc["split-admin"]?.environment?.PUBLIC_URL).toBe("");
		expect(computeAppContext(launch, hostPorts, APP_URL).app).toEqual({
			name: "split",
			...REFUSED_PRIMARY_ADDRESS,
		});
	});

	it("an unsatisfied supports: entry on its own refuses nothing — the optional mood (D-60 rule 6)", () => {
		const launch = readLaunch(split("", "supports"));
		expect(refusedComponents(launch, {}).size).toBe(0);
		expect(computeAppContext(launch, hostPorts).app.url).toBe(
			"http://localhost:13000",
		);
	});
});

describe("the refusal set's inputs", () => {
	it("certificate refusals are decided on the supplied resources bootstrap and release are handed", () => {
		const launch = readLaunch(CERTIFICATE);
		// With nothing supplied the binding is not selected: nothing refuses.
		expect(refusedComponents(launch, { appUrl: APP_URL }).size).toBe(0);
		expect(
			planBootstraps(launch, { hostPorts, secrets: {}, appUrl: APP_URL })[0]
				?.command,
		).toBe(`echo ${APP_URL} true`);
		expect(
			planBootstraps(launch, {
				hostPorts,
				secrets: {},
				appUrl: APP_URL,
				resources: HALF_CERT,
			})[0]?.command,
		).toBe("echo  false");
	});

	it("the same set answers whether the caller hands over its certificate plan or not", () => {
		const launch = readLaunch(CERTIFICATE);
		const planned = refusedComponents(launch, {
			appUrl: APP_URL,
			resources: HALF_CERT,
		});
		expect([...planned.keys()]).toEqual(["web"]);
	});

	it("skips are not refusals: a component with no image or build stays out of the set", () => {
		const launch = readLaunch(split("").replace("    image: web:1\n", ""));
		const result = launchToCompose(launch, { hostPorts, appUrl: APP_URL });
		expect(refusedComponents(launch, { appUrl: APP_URL }).size).toBe(0);
		expect(result.warnings).toContain("web: no image or build — skipped");
		expect(services(result.yaml)["split-web"]).toBeUndefined();
	});

	it("PROVISIONED_TYPES is exactly the set of factories the generator holds (D-64)", () => {
		expect([...PROVISIONED_TYPES].sort()).toEqual(
			[...provisionedTypes()].sort(),
		);
	});
});
