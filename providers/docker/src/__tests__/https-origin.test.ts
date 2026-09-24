/**
 * `https-origin` on `@launchfile/docker` (D-60): satisfy from the
 * orchestrator-supplied publication context, or refuse.
 *
 * This provider runs no edge of its own, so the only satisfaction it can offer
 * is an origin the orchestrator already owns — supplied through `appUrl`,
 * which for this type IS the D-56 supplied-resource channel (rule 5), not a
 * second one. Every branch here is decided on the supplied scheme; no branch
 * makes a network request.
 */

import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	computeAppContext,
	computeAppProperties,
	declaredPrimaryEndpoint,
	REFUSED_PRIMARY_ADDRESS,
} from "../app-url.js";
import { planBootstraps } from "../bootstrap.js";
import { launchToCompose } from "../compose-generator.js";
import { planReleases } from "../release.js";

const VAULTWARDEN = `
name: vaultwarden
image: vaultwarden/server:latest
provides:
  - name: web
    protocol: http
    port: 80
    exposed: true
requires:
  - type: https-origin
    endpoint: web
    set_env:
      DOMAIN: $url
`;

const GROCY = `
name: grocy
image: linuxserver/grocy:latest
provides:
  - name: web
    protocol: http
    port: 80
    exposed: true
supports:
  - type: https-origin
    endpoint: web
`;

const OPENCLAW = `
name: openclaw
image: ghcr.io/openclaw/openclaw:latest
provides:
  - name: gateway
    protocol: http
    port: 18789
    exposed: true
  - name: bridge
    protocol: http
    port: 18790
    exposed: true
requires:
  - type: https-origin
    endpoint: bridge
`;

function services(yaml: string): Record<string, { environment?: Record<string, string> }> {
	return (parse(yaml) as { services: Record<string, { environment?: Record<string, string> }> })
		.services;
}

describe("requires: https-origin", () => {
	it("is satisfied by an https:// appUrl and wires the set_env", () => {
		const result = launchToCompose(readLaunch(VAULTWARDEN), {
			appUrl: "https://vault.example.com",
		});
		expect(result.warnings).toEqual([]);
		expect(services(result.yaml).vaultwarden!.environment).toMatchObject({
			DOMAIN: "https://vault.example.com",
		});
	});

	it("refuses the component when the supplied appUrl is http://", () => {
		const result = launchToCompose(readLaunch(VAULTWARDEN), {
			appUrl: "http://vault.example.com",
		});
		expect(services(result.yaml).vaultwarden).toBeUndefined();
		const refusal = result.warnings.find((w) => w.startsWith("refused:"));
		expect(refusal).toContain("public HTTPS origin");
		expect(refusal).toContain('https-origin (endpoint "web")');
		expect(refusal).toContain('scheme is "http", not https');
	});

	it("refuses the component when no appUrl is supplied at all", () => {
		const result = launchToCompose(readLaunch(VAULTWARDEN));
		expect(services(result.yaml).vaultwarden).toBeUndefined();
		const refusal = result.warnings.find((w) => w.startsWith("refused:"));
		expect(refusal).toContain("no publication URL was supplied");
	});

	it("never emits a backing service for it, nor refuses it as an unprovisionable type", () => {
		const result = launchToCompose(readLaunch(VAULTWARDEN), {
			appUrl: "https://vault.example.com",
		});
		expect(Object.keys(services(result.yaml))).toEqual(["vaultwarden"]);
		expect(result.images).toEqual(["vaultwarden/server:latest"]);
		expect(result.warnings.join("\n")).not.toContain("refused:");
	});
});

describe("supports: https-origin — the optional mood (rule 6)", () => {
	it("deploys and notes the un-granted dependency when unsatisfied", () => {
		const result = launchToCompose(readLaunch(GROCY));
		expect(services(result.yaml).grocy).toBeDefined();
		expect(result.warnings.some((w) => w.startsWith("refused:"))).toBe(false);
		expect(result.warnings.join("\n")).toContain(
			"optional public HTTPS origin https-origin",
		);
	});

	it("wires its set_env when an https:// appUrl is supplied", () => {
		const withWiring = GROCY.replace(
			"    endpoint: web\n",
			"    endpoint: web\n    set_env:\n      GROCY_URL: $url\n",
		);
		const result = launchToCompose(readLaunch(withWiring), {
			appUrl: "https://grocy.example.com",
		});
		expect(services(result.yaml).grocy!.environment).toMatchObject({
			GROCY_URL: "https://grocy.example.com",
		});
	});
});

describe("rule 3 — the named endpoint is the primary", () => {
	// The optional mood: the entry names the primary and, unsatisfied, refuses
	// nothing — so this provider's own localhost answer is what resolves.
	const OPENCLAW_OPTIONAL = OPENCLAW.replace("requires:", "supports:");

	it("resolves $app.* from the named endpoint, not from published[0]", () => {
		const launch = readLaunch(OPENCLAW_OPTIONAL);
		expect(declaredPrimaryEndpoint(launch)).toMatchObject({
			component: "default",
			name: "bridge",
			key: "default:bridge",
			port: 18790,
			refused: false,
		});
		const app = computeAppProperties(launch, {
			openclaw: 10001,
			"default:bridge": 10002,
		});
		expect(app.url).toBe("http://localhost:10002");
		expect(app.port).toBe(10002);
	});

	it("falls back to the declared container port when none was allocated", () => {
		const app = computeAppProperties(readLaunch(OPENCLAW_OPTIONAL), undefined);
		expect(app.url).toBe("http://localhost:18790");
	});

	it("$<name>.url and $app.url resolve to the same string (rule 4)", () => {
		const wired = OPENCLAW.replace(
			"    endpoint: bridge\n",
			"    endpoint: bridge\n    set_env:\n      ORIGIN: $url\n      ALSO: $app.url\n",
		);
		const result = launchToCompose(readLaunch(wired), {
			appUrl: "https://claw.example.com",
		});
		const env = services(result.yaml).openclaw!.environment!;
		expect(env.ORIGIN).toBe("https://claw.example.com");
		expect(env.ALSO).toBe(env.ORIGIN);
	});

	it("declaration fixes the primary even when the entry is refused — and then it has no address (D-next)", () => {
		const launch = readLaunch(OPENCLAW);
		expect(declaredPrimaryEndpoint(launch)).toMatchObject({
			key: "default:bridge",
			refused: true,
		});
		expect(declaredPrimaryEndpoint(launch, "https://claw.example.com")?.refused).toBe(false);
		const app = computeAppProperties(launch, {
			openclaw: 10001,
			"default:bridge": 10002,
		});
		// Neither the positional fallback (gateway's port) nor an address for
		// the bridge this provider will not generate.
		expect(app.url).toBe("");
		expect(app.port).toBe("");
	});

	it("leaves $components.<name>.url alone (D-33)", () => {
		const twoParts = `
name: split
components:
  web:
    image: web:1
    provides:
      - name: ui
        protocol: http
        port: 3000
        exposed: true
    requires:
      - type: https-origin
        endpoint: ui
  worker:
    image: worker:1
    env:
      UPSTREAM: $components.web.url
`;
		const result = launchToCompose(readLaunch(twoParts), {
			appUrl: "https://split.example.com",
		});
		expect(services(result.yaml)["split-worker"]!.environment).toMatchObject({
			UPSTREAM: "http://split-web:3000",
		});
	});
});

/**
 * The D-next trigger shape: the declaring component is refused, and a sibling
 * with its own `exposed: true` HTTP endpoint survives.
 */
const SPLIT_REFUSED = `
name: split
components:
  web:
    image: web:1
    provides:
      - name: ui
        protocol: http
        port: 3000
        exposed: true
    requires:
      - type: https-origin
        endpoint: ui
  admin:
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

describe("a refused primary keeps its place and has no address (D-next)", () => {
	const launch = readLaunch(SPLIT_REFUSED);
	const hostPorts = { web: 13000, admin: 14000 };

	function survivor(appUrl?: string) {
		const result = launchToCompose(launch, { hostPorts, appUrl });
		const svc = services(result.yaml);
		expect(svc["split-web"]).toBeUndefined();
		return { result, env: svc["split-admin"]!.environment! };
	}

	it("resolves $app.* to the empty address for the survivor — never the survivor's own port", () => {
		const { result, env } = survivor();
		expect(result.warnings.find((w) => w.startsWith("refused:"))).toContain("web");
		expect(env).toMatchObject({
			PUBLIC_URL: "",
			APP_HOST: "",
			APP_PORT: "",
			APP_SCHEME: "",
			APP_AUTHORITY: "",
			USE_TLS: "false",
			APP_NAME: "split",
		});
		expect(env.OWN_URL).toBe("http://localhost:14000");
	});

	it("never answers with the supplied URL that failed to satisfy the entry", () => {
		const { result, env } = survivor("http://split.example.com");
		expect(result.warnings.find((w) => w.startsWith("refused:"))).toContain(
			'scheme is "http", not https',
		);
		expect(env.PUBLIC_URL).toBe("");
		expect(env.USE_TLS).toBe("false");
	});

	it("$app.endpoints.<primary>.* reads the same empty answer from the same derivation (D-63 rule 2)", () => {
		const { env } = survivor();
		expect(env.PRIMARY_URL).toBe("");
		const { app, appEndpoints } = computeAppContext(launch, hostPorts);
		expect(app).toEqual({ name: "split", ...REFUSED_PRIMARY_ADDRESS });
		expect(appEndpoints.ui).toEqual(REFUSED_PRIMARY_ADDRESS);
		expect(appEndpoints.panel?.url).toBe("http://localhost:14000");
	});

	it("bootstrap and release agree with the environment", () => {
		const { result, env } = survivor();
		const bootstrap = planBootstraps(launch, { hostPorts, secrets: {} })[0]!.command;
		const release = planReleases(launch, {
			services: result.services,
			hostPorts,
			secrets: {},
		})[0]!.command;
		expect(bootstrap).toBe(`echo ${env.PUBLIC_URL} ${env.USE_TLS}`);
		expect(release).toBe(bootstrap);
	});
});

describe("apps that declare no https-origin entry", () => {
	it("keep the positional primary and byte-identical output", () => {
		const plain = `
name: plain
image: app:1
provides:
  - protocol: http
    port: 8080
    exposed: true
  - name: metrics
    protocol: http
    port: 9090
    exposed: true
`;
		const launch = readLaunch(plain);
		expect(declaredPrimaryEndpoint(launch)).toBeUndefined();
		expect(computeAppProperties(launch, undefined).url).toBe(
			"http://localhost:8080",
		);
	});
});
