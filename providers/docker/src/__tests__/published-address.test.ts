/**
 * One derivation of a published endpoint's address (#473).
 *
 * `$app.*` and the `status`/`up` printout are two surfaces onto the same
 * address. Every case here asserts they agree byte for byte, because they
 * used to drift: the `$app.*` path read only whether a certificate binding
 * was active, while the printout switched on the declared protocol.
 */

import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	computeAppProperties,
	publishedAddress,
	publishedEndpointAddresses,
} from "../app-url.js";
import { type ComposeOpts, launchToCompose } from "../compose-generator.js";
import { endpointAddress } from "../provider.js";

/** The #473 fixture: a component that terminates TLS itself, no binding. */
const SELF_TLS = `
name: selftls
image: acme/selftls:1
provides:
  - name: web
    protocol: https
    port: 8443
    exposed: true
env:
  APP_URL: $app.url
  APP_SCHEME: $app.scheme
  APP_TLS: $app.tls
`;

/** The same listener declared http, with TLS arriving from a binding (D-61). */
const BOUND_CERT = `
name: boundcert
image: acme/boundcert:1
provides:
  - name: web
    protocol: http
    port: 3000
    exposed: true
    tls: server-cert
supports:
  - name: server-cert
    type: certificate
env:
  APP_URL: $app.url
`;

const ACTIVE: ComposeOpts["resources"] = {
	"server-cert": { properties: { cert_file: "/tls/c.pem", key_file: "/tls/k.pem" } },
};

/** Non-HTTP listener protocols, which D-60 rule 4 keeps on the http origin. */
const WS_AND_GRPC = `
name: wsgrpc
components:
  socket:
    image: acme/socket:1
    provides:
      - name: live
        protocol: ws
        port: 9000
        exposed: true
    env:
      APP_URL: $app.url
  rpc:
    image: acme/rpc:1
    provides:
      - name: api
        protocol: grpc
        port: 50051
        exposed: true
`;

/** An `https-origin` naming a non-first endpoint as the primary (D-60 rule 3). */
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
  APP_URL: $app.url
`;

function envOf(yaml: string, service: string): Record<string, string> {
	const doc = parse(yaml) as {
		services: Record<string, { environment?: Record<string, string> }>;
	};
	return doc.services[service]!.environment ?? {};
}

/** What `status` / `up` print for one ports-map key. */
function printedAddress(result: ReturnType<typeof launchToCompose>, key: string): string {
	return endpointAddress(result.ports[key]!, result.endpoints[key]?.protocol);
}

describe("a declared `protocol: https` listener with no certificate binding (#473)", () => {
	const opts: ComposeOpts = { hostPorts: { default: 18443 } };

	it("gives $app.url the https scheme the entry declares", () => {
		const env = envOf(launchToCompose(readLaunch(SELF_TLS), opts).yaml, "selftls");
		expect(env.APP_URL).toBe("https://localhost:18443");
		expect(env.APP_SCHEME).toBe("https");
		expect(env.APP_TLS).toBe("true");
	});

	it("prints the same address it wrote into the app's config", () => {
		const result = launchToCompose(readLaunch(SELF_TLS), opts);
		expect(printedAddress(result, "default")).toBe("https://localhost:18443");
		expect(printedAddress(result, "default")).toBe(
			envOf(result.yaml, "selftls").APP_URL,
		);
	});
});

describe("an active certificate binding on a declared `http` listener (D-61 rule 2)", () => {
	const opts: ComposeOpts = { hostPorts: { default: 13000 }, resources: ACTIVE };

	it("moves both surfaces to https together", () => {
		const result = launchToCompose(readLaunch(BOUND_CERT), opts);
		expect(envOf(result.yaml, "boundcert").APP_URL).toBe("https://localhost:13000");
		expect(printedAddress(result, "default")).toBe("https://localhost:13000");
	});

	it("keeps both on http while the binding is unselected (D-8)", () => {
		const result = launchToCompose(readLaunch(BOUND_CERT), {
			hostPorts: { default: 13000 },
		});
		expect(envOf(result.yaml, "boundcert").APP_URL).toBe("http://localhost:13000");
		expect(printedAddress(result, "default")).toBe("http://localhost:13000");
	});
});

describe("non-HTTP listener protocols (D-60 rule 4)", () => {
	const result = launchToCompose(readLaunch(WS_AND_GRPC), {
		hostPorts: { socket: 19000, rpc: 50051 },
	});

	it("keeps $app.url on the http origin for a ws primary", () => {
		expect(envOf(result.yaml, "wsgrpc-socket").APP_URL).toBe("http://localhost:19000");
	});

	it("derives http for a grpc listener too", () => {
		const [api] = publishedEndpointAddresses("rpc", readLaunch(WS_AND_GRPC).components.rpc!.provides, {
			rpc: 50051,
		});
		expect(api!.address.url).toBe("http://localhost:50051");
		expect(api!.address.scheme).toBe("http");
	});

	it("still prints ws and grpc endpoints in their own readable form", () => {
		// The printout is a rendering choice, not a second scheme derivation:
		// an `http://` link to a gRPC port would be wrong to click.
		expect(printedAddress(result, "socket")).toBe("ws://localhost:19000");
		expect(printedAddress(result, "rpc")).toBe("localhost:50051 (grpc)");
	});
});

describe("a supplied publication context (D-58 rules 2 and 5)", () => {
	const opts: ComposeOpts = {
		hostPorts: { default: 18443 },
		appUrl: "https://notes.example.com",
	};

	it("wins over the listener for $app.*", () => {
		const env = envOf(launchToCompose(readLaunch(SELF_TLS), opts).yaml, "selftls");
		expect(env.APP_URL).toBe("https://notes.example.com");
		expect(env.APP_SCHEME).toBe("https");
	});

	it("leaves the printed host address alone (#386 is a separate question)", () => {
		const result = launchToCompose(readLaunch(SELF_TLS), opts);
		expect(printedAddress(result, "default")).toBe("https://localhost:18443");
	});
});

describe("an `https-origin` naming the primary endpoint (D-60 rule 3)", () => {
	const opts: ComposeOpts = { hostPorts: { default: 18789, "default:bridge": 18790 } };

	it("resolves $app.* from the named endpoint, not the first one", () => {
		const env = envOf(launchToCompose(readLaunch(NAMED_PRIMARY), opts).yaml, "openclaw");
		expect(env.APP_URL).toBe("https://localhost:18790");
	});

	it("prints every published endpoint from the same derivation", () => {
		const result = launchToCompose(readLaunch(NAMED_PRIMARY), opts);
		expect(printedAddress(result, "default")).toBe("http://localhost:18789");
		expect(printedAddress(result, "default:bridge")).toBe("https://localhost:18790");
		expect(printedAddress(result, "default:bridge")).toBe(
			envOf(result.yaml, "openclaw").APP_URL,
		);
	});
});

describe("publishedAddress", () => {
	it("gives no address at all when the app publishes nothing", () => {
		const address = publishedAddress(undefined, 0);
		expect(address).toEqual({
			host: "localhost",
			port: 0,
			url: "",
			authority: "",
			scheme: "",
			tls: "",
		});
	});

	it("reads the scheme default from a supplied URL with no explicit port", () => {
		expect(publishedAddress("http", 8080, "https://notes.example.com")).toEqual({
			host: "notes.example.com",
			port: 443,
			url: "https://notes.example.com",
			authority: "notes.example.com",
			scheme: "https",
			tls: "true",
		});
	});

	it("is the only place $app.* and the printout get their scheme", () => {
		const launch = readLaunch(SELF_TLS);
		const app = computeAppProperties(launch, { default: 18443 });
		expect(app.url).toBe(publishedAddress("https", 18443).url);
		expect(endpointAddress(18443, "https")).toBe(String(app.url));
	});
});
