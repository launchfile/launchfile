/**
 * `$app.endpoints.<name>.*` — per-endpoint publication context (D-63).
 *
 * Every named published endpoint resolves its public address through
 * `publishedAddress`, the same derivation `$app.*` and the printout read
 * (#473), so the primary's entry is `$app.*` byte for byte (rule 2), the
 * scheme follows the effective listener (rule 3, D-61 rule 2), a `tcp`/`udp`
 * endpoint has no origin (rule 3), and a supplied publication URL asserts the
 * primary's address only (rule 5, D-58 rule 4).
 */

import { APP_ENDPOINT_PROPERTIES, readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { computeAppContext, computeAppProperties } from "../app-url.js";
import { planBootstraps } from "../bootstrap.js";
import { type ComposeOpts, launchToCompose } from "../compose-generator.js";
import { endpointAddress } from "../provider.js";
import { planReleases } from "../release.js";

/** gitea's shape: an http primary with a certificate binding, then a tcp `ssh`. */
const GITEA = `
name: gitea
image: gitea/gitea:latest
provides:
  - name: web
    protocol: http
    port: 3000
    exposed: true
    tls: server-cert
  - name: ssh
    protocol: tcp
    port: 22
    exposed: true
supports:
  - name: server-cert
    type: certificate
env:
  ROOT_URL:
    default: $app.url
  WEB_URL:
    default: $app.endpoints.web.url
  WEB_HOST:
    default: $app.endpoints.web.host
  WEB_PORT:
    default: $app.endpoints.web.port
  WEB_SCHEME:
    default: $app.endpoints.web.scheme
  WEB_AUTHORITY:
    default: $app.endpoints.web.authority
  WEB_TLS:
    default: $app.endpoints.web.tls
  SSH_DOMAIN:
    default: $app.endpoints.ssh.host
  SSH_PORT:
    default: $app.endpoints.ssh.port
  SSH_AUTHORITY:
    default: $app.endpoints.ssh.authority
  SSH_URL:
    default: $app.endpoints.ssh.url
  SSH_SCHEME:
    default: $app.endpoints.ssh.scheme
  SSH_TLS:
    default: $app.endpoints.ssh.tls
  CLONE_URL:
    default: "ssh://git@\${app.endpoints.ssh.host}:\${app.endpoints.ssh.port}/org/repo.git"
  NO_NAME:
    default: $app.endpoints
  NO_PROP:
    default: $app.endpoints.ssh
  UNKNOWN:
    default: $app.endpoints.sshd.host
commands:
  bootstrap: echo $app.endpoints.ssh.port $app.endpoints.web.url
  release: echo $app.endpoints.ssh.port $app.endpoints.web.url
`;

const ACTIVE_CERT: ComposeOpts["resources"] = {
	"server-cert": {
		properties: { cert_file: "/tls/c.pem", key_file: "/tls/k.pem" },
	},
};

/** openclaw's shape: an `https-origin` names the second endpoint as the primary. */
const NAMED_PRIMARY = `
name: openclaw
image: ghcr.io/openclaw/openclaw:latest
provides:
  - name: gateway
    protocol: http
    port: 18789
    exposed: true
  - name: bridge
    protocol: https
    port: 18790
    exposed: true
supports:
  - type: https-origin
    endpoint: bridge
env:
  APP_URL:
    default: $app.url
  BRIDGE_URL:
    default: $app.endpoints.bridge.url
  GATEWAY_URL:
    default: $app.endpoints.gateway.url
`;

/** wg-easy's shape: an http web UI and a udp WireGuard endpoint. */
const WG_EASY = `
name: wg-easy
image: ghcr.io/wg-easy/wg-easy:15
provides:
  - name: web
    protocol: http
    port: 51821
    exposed: true
  - name: wg
    protocol: udp
    port: 51820
    exposed: true
env:
  INIT_HOST:
    default: $app.endpoints.wg.host
  INIT_PORT:
    default: $app.endpoints.wg.port
  WG_URL:
    default: $app.endpoints.wg.url
  WG_TLS:
    default: $app.endpoints.wg.tls
`;

/** Names are app-wide: the key is the endpoint name, whichever component owns it. */
const TWO_COMPONENTS = `
name: pair
components:
  default:
    image: acme/web:1
    provides:
      - name: web
        protocol: http
        port: 3000
        exposed: true
    env:
      PEER_PORT:
        default: $app.endpoints.metrics.port
  sidecar:
    image: acme/metrics:1
    provides:
      - protocol: http
        port: 9000
        exposed: true
      - name: metrics
        protocol: http
        port: 9100
        exposed: true
    env:
      WEB_URL:
        default: $app.endpoints.web.url
`;

function envOf(yaml: string, service: string): Record<string, string> {
	const doc = parse(yaml) as {
		services: Record<string, { environment?: Record<string, string> }>;
	};
	return doc.services[service]!.environment ?? {};
}

const GITEA_PORTS = { default: 13000, "default:ssh": 49222 };

describe("a named endpoint that is not provides[0] (rule 1)", () => {
	const env = envOf(
		launchToCompose(readLaunch(GITEA), { hostPorts: GITEA_PORTS }).yaml,
		"gitea",
	);

	it("resolves the host port allocated for that endpoint, not the first one's", () => {
		expect(env.SSH_PORT).toBe("49222");
		expect(env.SSH_DOMAIN).toBe("localhost");
		expect(env.SSH_AUTHORITY).toBe("localhost:49222");
	});

	it("composes into a clone URL", () => {
		expect(env.CLONE_URL).toBe("ssh://git@localhost:49222/org/repo.git");
	});
});

describe("the primary's entry is $app.* byte for byte (rule 2)", () => {
	it("holds when the primary is positional (gitea's web)", () => {
		const env = envOf(
			launchToCompose(readLaunch(GITEA), { hostPorts: GITEA_PORTS }).yaml,
			"gitea",
		);
		expect(env.WEB_URL).toBe(env.ROOT_URL);
		expect(env.WEB_URL).toBe("http://localhost:13000");
		const { app, appEndpoints } = computeAppContext(
			readLaunch(GITEA),
			GITEA_PORTS,
		);
		for (const prop of APP_ENDPOINT_PROPERTIES) {
			expect(appEndpoints.web![prop]).toBe(app[prop]);
		}
		expect(computeAppProperties(readLaunch(GITEA), GITEA_PORTS)).toEqual(app);
	});

	it("holds when an https-origin names the primary (openclaw's bridge)", () => {
		const env = envOf(
			launchToCompose(readLaunch(NAMED_PRIMARY), {
				hostPorts: { default: 18789, "default:bridge": 18790 },
			}).yaml,
			"openclaw",
		);
		expect(env.APP_URL).toBe("https://localhost:18790");
		expect(env.BRIDGE_URL).toBe(env.APP_URL);
		expect(env.GATEWAY_URL).toBe("http://localhost:18789");
	});

	it("holds under a supplied publication URL", () => {
		const { app, appEndpoints } = computeAppContext(
			readLaunch(GITEA),
			GITEA_PORTS,
			"https://git.example.com",
		);
		expect(app.url).toBe("https://git.example.com");
		for (const prop of APP_ENDPOINT_PROPERTIES) {
			expect(appEndpoints.web![prop]).toBe(app[prop]);
		}
	});

	it("is the address the printout shows for that endpoint (#473)", () => {
		const result = launchToCompose(readLaunch(GITEA), {
			hostPorts: GITEA_PORTS,
		});
		expect(
			endpointAddress(
				result.ports.default!,
				result.endpoints.default?.protocol,
			),
		).toBe(envOf(result.yaml, "gitea").WEB_URL);
	});
});

describe("scheme, tls and url read the effective listener (rule 3, D-61 rule 2)", () => {
	it("reads https when the certificate binding is active, and stays $app.*", () => {
		const env = envOf(
			launchToCompose(readLaunch(GITEA), {
				hostPorts: GITEA_PORTS,
				resources: ACTIVE_CERT,
			}).yaml,
			"gitea",
		);
		expect(env.WEB_SCHEME).toBe("https");
		expect(env.WEB_TLS).toBe("true");
		expect(env.WEB_URL).toBe("https://localhost:13000");
		expect(env.WEB_URL).toBe(env.ROOT_URL);
		expect(env.WEB_AUTHORITY).toBe("localhost:13000");
	});

	it("reads http while the binding is inactive", () => {
		const env = envOf(
			launchToCompose(readLaunch(GITEA), { hostPorts: GITEA_PORTS }).yaml,
			"gitea",
		);
		expect(env.WEB_SCHEME).toBe("http");
		expect(env.WEB_TLS).toBe("false");
		expect(env.WEB_HOST).toBe("localhost");
		expect(env.WEB_PORT).toBe("13000");
	});
});

describe("a tcp or udp endpoint has no origin (rule 3)", () => {
	it("gives gitea's ssh host, authority and port, and empty url and scheme, tls false", () => {
		const env = envOf(
			launchToCompose(readLaunch(GITEA), { hostPorts: GITEA_PORTS }).yaml,
			"gitea",
		);
		expect(env.SSH_URL).toBe("");
		expect(env.SSH_SCHEME).toBe("");
		expect(env.SSH_TLS).toBe("false");
		expect(env.SSH_DOMAIN).toBe("localhost");
		expect(env.SSH_PORT).toBe("49222");
		expect(env.SSH_AUTHORITY).toBe("localhost:49222");
	});

	it("does the same for wg-easy's udp endpoint", () => {
		const env = envOf(
			launchToCompose(readLaunch(WG_EASY), {
				hostPorts: { default: 51821, "default:wg": 51820 },
			}).yaml,
			"wg-easy",
		);
		expect(env.INIT_HOST).toBe("localhost");
		expect(env.INIT_PORT).toBe("51820");
		expect(env.WG_URL).toBe("");
		expect(env.WG_TLS).toBe("false");
	});
});

describe("the empty answer (rule 4, L-4)", () => {
	const result = launchToCompose(readLaunch(GITEA), { hostPorts: GITEA_PORTS });
	const env = envOf(result.yaml, "gitea");

	it("resolves the two- and three-segment forms and an unknown name to nothing", () => {
		expect(env.NO_NAME).toBe("");
		expect(env.NO_PROP).toBe("");
		expect(env.UNKNOWN).toBe("");
	});

	it("registers no entry for an unnamed endpoint", () => {
		const { appEndpoints } = computeAppContext(readLaunch(TWO_COMPONENTS), {
			default: 3000,
			sidecar: 9000,
			"sidecar:metrics": 9100,
		});
		expect(Object.keys(appEndpoints).sort()).toEqual(["metrics", "web"]);
	});

	it("is not a provider warning — validate names these forms", () => {
		expect(result.warnings.filter((w) => w.includes("app.endpoints"))).toEqual(
			[],
		);
	});
});

describe("a supplied publication URL asserts the primary's address only (rule 5, D-58 rule 4)", () => {
	const opts: ComposeOpts = {
		hostPorts: GITEA_PORTS,
		appUrl: "https://git.example.com",
	};
	const result = launchToCompose(readLaunch(GITEA), opts);
	const env = envOf(result.yaml, "gitea");

	it("resolves the primary from the supplied URL", () => {
		expect(env.WEB_URL).toBe("https://git.example.com");
		expect(env.WEB_HOST).toBe("git.example.com");
		expect(env.WEB_PORT).toBe("443");
	});

	it("resolves every property of a non-primary endpoint to nothing — never a value derived from the URL", () => {
		for (const key of [
			"SSH_DOMAIN",
			"SSH_PORT",
			"SSH_AUTHORITY",
			"SSH_URL",
			"SSH_SCHEME",
			"SSH_TLS",
		]) {
			expect(env[key]).toBe("");
		}
		expect(env.CLONE_URL).toBe("ssh://git@:/org/repo.git");
	});

	it("warns once, naming the endpoint the file references", () => {
		const fence = result.warnings.filter((w) =>
			w.startsWith("$app.endpoints.ssh.*"),
		);
		expect(fence).toHaveLength(1);
		expect(fence[0]).toContain("D-58 rule 4");
	});

	it("stays silent about a fenced endpoint the file never references", () => {
		const quiet = launchToCompose(
			readLaunch(WG_EASY.replace(/\$app\.endpoints\.wg\.\w+/g, "x")),
			{
				hostPorts: { default: 51821, "default:wg": 51820 },
				appUrl: "https://vpn.example.com",
			},
		);
		expect(quiet.warnings.some((w) => w.includes("app.endpoints"))).toBe(false);
		expect(
			computeAppContext(
				readLaunch(WG_EASY),
				undefined,
				"https://vpn.example.com",
			).fenced,
		).toEqual(["wg"]);
	});
});

describe("the key is the endpoint name, not the component (rule 4)", () => {
	const result = launchToCompose(readLaunch(TWO_COMPONENTS), {
		hostPorts: { default: 3000, sidecar: 9000, "sidecar:metrics": 9100 },
	});

	it("reaches an endpoint on another component by name", () => {
		expect(envOf(result.yaml, "pair").PEER_PORT).toBe("9100");
		expect(envOf(result.yaml, "pair-sidecar").WEB_URL).toBe(
			"http://localhost:3000",
		);
	});
});

describe("bootstrap and release resolve the same values as env (three-site parity)", () => {
	const launch = readLaunch(GITEA);
	const compose = launchToCompose(launch, { hostPorts: GITEA_PORTS });
	const env = envOf(compose.yaml, "gitea");
	const expected = `echo ${env.SSH_PORT} ${env.WEB_URL}`;

	it("in bootstrap", () => {
		const [item] = planBootstraps(launch, {
			hostPorts: GITEA_PORTS,
			secrets: {},
		});
		expect(item!.command).toBe(expected);
		expect(item!.command).toBe("echo 49222 http://localhost:13000");
	});

	it("in release", () => {
		const [item] = planReleases(launch, {
			services: compose.services,
			hostPorts: GITEA_PORTS,
			secrets: {},
		});
		expect(item!.command).toBe(expected);
	});
});
