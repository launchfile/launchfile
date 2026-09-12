/**
 * Orchestrator-supplied publication context (D-58): this provider's `$app.*`
 * derivation from a supplied `appUrl` (D-33, D-35) and the three-site parity
 * guarantee — env generation, bootstrap, and release resolve identical
 * `$app.*` for one deployment. The validation contract itself is the SDK's
 * (`sdk/src/__tests__/app-url.test.ts`); what is checked here is that this
 * provider raises it rather than a copy.
 */

import {
	readLaunch,
	InvalidAppUrlError as SdkInvalidAppUrlError,
	normalizeAppUrl as sdkNormalizeAppUrl,
	suppliedAppAddress,
} from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	computeAppProperties,
	InvalidAppUrlError,
	normalizeAppUrl,
	publishedAddress,
} from "../app-url.js";
import { planBootstraps } from "../bootstrap.js";
import { launchToCompose } from "../compose-generator.js";
import { planReleases } from "../release.js";

describe("normalizeAppUrl re-export (D-58 rule 3)", () => {
	it("is the SDK's normalizer, not a provider-local copy", () => {
		expect(normalizeAppUrl).toBe(sdkNormalizeAppUrl);
		expect(InvalidAppUrlError).toBe(SdkInvalidAppUrlError);
	});

	it("refuses a malformed value through this provider's entry point", () => {
		expect(() => normalizeAppUrl("notes.example.com")).toThrow(
			InvalidAppUrlError,
		);
	});

	it("derives a supplied URL's address through the SDK, not a local copy (D-58 rule 2)", () => {
		for (const url of [
			"https://notes.example.com",
			"http://intranet.local:8080/notes",
		]) {
			expect(publishedAddress("http", 49400, url)).toEqual(
				suppliedAppAddress(url),
			);
		}
	});
});

const PARITY_LAUNCHFILE = `version: launch/v1
name: paritytest
components:
  web:
    image: nginx:1.27
    provides:
      - protocol: http
        port: 8080
        exposed: true
    env:
      PUBLIC_URL:
        default: $app.url
      DOMAIN:
        default: $app.authority
      USE_TLS:
        default: $app.tls
      APP_HOST:
        default: $app.host
      APP_PORT:
        default: $app.port
      APP_SCHEME:
        default: $app.scheme
    commands:
      bootstrap: echo $app.url $app.authority $app.tls $app.host $app.port $app.scheme
      release: echo $app.url $app.authority $app.tls $app.host $app.port $app.scheme
`;

describe("computeAppProperties with appUrl (#290, D-33, D-35)", () => {
	const launch = readLaunch(PARITY_LAUNCHFILE);

	it("resolves the full property set from the supplied URL", () => {
		expect(
			computeAppProperties(launch, { web: 49400 }, "https://notes.example.com"),
		).toEqual({
			name: "paritytest",
			host: "notes.example.com",
			port: 443,
			url: "https://notes.example.com",
			authority: "notes.example.com",
			scheme: "https",
			tls: "true",
		});
	});

	it("uses the scheme default port for http and the explicit port when given", () => {
		expect(
			computeAppProperties(launch, { web: 49400 }, "http://intranet.local"),
		).toMatchObject({ port: 80, tls: "false", scheme: "http" });
		expect(
			computeAppProperties(
				launch,
				{ web: 49400 },
				"https://x.example.com:8443",
			),
		).toMatchObject({
			port: 8443,
			authority: "x.example.com:8443",
			url: "https://x.example.com:8443",
		});
	});

	it("keeps a subpath in $app.url while authority/host drop it", () => {
		expect(
			computeAppProperties(launch, undefined, "https://example.com/notes"),
		).toMatchObject({
			url: "https://example.com/notes",
			authority: "example.com",
			host: "example.com",
		});
	});

	it("keeps $app.name and ignores host ports for the address", () => {
		const props = computeAppProperties(
			launch,
			{ web: 49400 },
			"https://notes.example.com",
		);
		expect(props.name).toBe("paritytest");
		expect(String(props.url)).not.toContain("49400");
	});

	it("unset appUrl keeps the localhost routing answer", () => {
		expect(computeAppProperties(launch, { web: 49400 })).toEqual({
			name: "paritytest",
			host: "localhost",
			port: 49400,
			url: "http://localhost:49400",
			authority: "localhost:49400",
			scheme: "http",
			tls: "false",
		});
	});

	it("refuses a malformed appUrl instead of degrading", () => {
		expect(() =>
			computeAppProperties(launch, { web: 49400 }, "notes.example.com"),
		).toThrow(InvalidAppUrlError);
	});
});

describe("three-site $app.* parity (#290: env, bootstrap, release agree)", () => {
	const launch = readLaunch(PARITY_LAUNCHFILE);
	const hostPorts = { web: 49400 };

	function resolvedSites(appUrl?: string): {
		env: Record<string, string>;
		bootstrap: string;
		release: string;
	} {
		const compose = launchToCompose(launch, { hostPorts, appUrl });
		const doc = parse(compose.yaml) as {
			services: Record<string, { environment: Record<string, string> }>;
		};
		const env = doc.services["paritytest-web"]!.environment;

		const bootstrap = planBootstraps(launch, {
			hostPorts,
			secrets: {},
			appUrl,
		})[0]!.command;

		const release = planReleases(launch, {
			services: compose.services,
			hostPorts,
			secrets: {},
			appUrl,
		})[0]!.command;

		return { env, bootstrap, release };
	}

	function expectedCommand(env: Record<string, string>): string {
		return `echo ${env.PUBLIC_URL} ${env.DOMAIN} ${env.USE_TLS} ${env.APP_HOST} ${env.APP_PORT} ${env.APP_SCHEME}`;
	}

	it("all three sites resolve identical $app.* with an appUrl", () => {
		const { env, bootstrap, release } = resolvedSites(
			"https://notes.example.com",
		);
		expect(env.PUBLIC_URL).toBe("https://notes.example.com");
		expect(env.DOMAIN).toBe("notes.example.com");
		expect(env.USE_TLS).toBe("true");
		expect(env.APP_HOST).toBe("notes.example.com");
		expect(env.APP_PORT).toBe("443");
		expect(env.APP_SCHEME).toBe("https");
		expect(bootstrap).toBe(expectedCommand(env));
		expect(release).toBe(expectedCommand(env));
	});

	it("all three sites resolve identical $app.* without one (localhost routing)", () => {
		const { env, bootstrap, release } = resolvedSites(undefined);
		expect(env.PUBLIC_URL).toBe("http://localhost:49400");
		expect(bootstrap).toBe(expectedCommand(env));
		expect(release).toBe(expectedCommand(env));
	});
});
