/**
 * Certificate bindings on `@launchfile/docker` (D-61): activate from the
 * supplied-resource channel, or refuse before launch.
 *
 * Selection is arrival through `ComposeOpts.resources` — the D-56 channel
 * every other optional resource already uses on this provider. No branch here
 * opens, parses or probes a certificate: D-56 rule 3 stands.
 */

import { readLaunch } from "@launchfile/sdk";
import { Writable } from "node:stream";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type ComposeOpts, launchToCompose } from "../compose-generator.js";
import { dockerLaunchError } from "../errors.js";
import { REDACT_CONFIG } from "../logger.js";
import { clearRegisteredSecrets, REDACTED, redactSecrets } from "../redact.js";

/** gitea as the catalog carries it after adoption, plus a sibling reader. */
const GITEA = `
name: gitea
components:
  gitea:
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
        set_env:
          GITEA__server__PROTOCOL: https
          GITEA__server__HTTP_PORT: "3000"
          GITEA__server__CERT_FILE: $cert_file
          GITEA__server__KEY_FILE: $key_file
    env:
      GITEA__server__PROTOCOL: http
  sidecar:
    image: acme/sidecar:1
    env:
      UPSTREAM: $components.gitea.url
      UPSTREAM_WEB: $components.gitea.web.url
      UPSTREAM_WEB_PROTOCOL: $components.gitea.web.protocol
      APP_URL: $app.url
`;

const CERT_PATH = "/run/secrets/tls/gitea.crt";
const KEY_PATH = "/run/secrets/tls/gitea.key";

const SELECTED: ComposeOpts["resources"] = {
	"server-cert": {
		properties: { cert_file: CERT_PATH, key_file: KEY_PATH },
	},
};

interface ComposeDoc {
	services: Record<string, { environment?: Record<string, string> }>;
}

const compose = (yaml: string, opts: ComposeOpts = {}) => {
	const result = launchToCompose(readLaunch(yaml), opts);
	return { ...result, doc: parse(result.yaml) as ComposeDoc };
};

beforeEach(() => {
	clearRegisteredSecrets();
});

describe("the binding is inactive unless it is selected (D-61 rule 1)", () => {
	it("deploys the declared HTTP baseline with the `env:` value intact", () => {
		const { doc, warnings } = compose(GITEA);
		const env = doc.services["gitea-gitea"]!.environment!;
		expect(env.GITEA__server__PROTOCOL).toBe("http");
		expect(env.GITEA__server__CERT_FILE).toBeUndefined();
		expect(env.GITEA__server__KEY_FILE).toBeUndefined();
		expect(env.GITEA__server__HTTP_PORT).toBeUndefined();
		// The component still deploys — D-8: an unavailable optional resource
		// means absent bindings, not a refusal.
		expect(doc.services["gitea-gitea"]).toBeDefined();
		expect(warnings.join("\n")).toContain("optional resource server-cert");
	});

	it("publishes the declared protocol to siblings and to $app.url", () => {
		const { doc } = compose(GITEA);
		expect(doc.services["gitea-sidecar"]!.environment!.UPSTREAM).toBe(
			"http://gitea-gitea:3000",
		);
		expect(doc.services["gitea-sidecar"]!.environment!.UPSTREAM_WEB).toBe(
			"http://gitea-gitea:3000",
		);
		expect(doc.services["gitea-sidecar"]!.environment!.UPSTREAM_WEB_PROTOCOL).toBe("http");
		expect(doc.services["gitea-sidecar"]!.environment!.APP_URL).toMatch(/^http:\/\//);
	});
});

describe("a selected, satisfied binding activates (D-61 rules 2 and 3)", () => {
	it("writes the binding's `set_env` over a same-named `env:` value", () => {
		const { doc } = compose(GITEA, { resources: SELECTED });
		const env = doc.services["gitea-gitea"]!.environment!;
		expect(env.GITEA__server__PROTOCOL).toBe("https");
		expect(env.GITEA__server__HTTP_PORT).toBe("3000");
		expect(env.GITEA__server__CERT_FILE).toBe(CERT_PATH);
		expect(env.GITEA__server__KEY_FILE).toBe(KEY_PATH);
	});

	it("gives a sibling the effective protocol on the declared port", () => {
		const { doc } = compose(GITEA, { resources: SELECTED });
		expect(doc.services["gitea-sidecar"]!.environment!.UPSTREAM).toBe(
			"https://gitea-gitea:3000",
		);
	});

	it("gives the named-endpoint form the same effective listener (D-66 rule 3)", () => {
		const { doc } = compose(GITEA, { resources: SELECTED });
		const env = doc.services["gitea-sidecar"]!.environment!;
		expect(env.UPSTREAM_WEB).toBe("https://gitea-gitea:3000");
		expect(env.UPSTREAM_WEB_PROTOCOL).toBe("https");
	});

	it("gives `$app.url` the effective protocol when the provider publishes it", () => {
		const { doc } = compose(GITEA, {
			resources: SELECTED,
			hostPorts: { gitea: 13000 },
		});
		expect(doc.services["gitea-sidecar"]!.environment!.APP_URL).toBe(
			"https://localhost:13000",
		);
	});

	it("lets a supplied publication context win over the effective listener", () => {
		// D-58 rule 5: the orchestrator owns the public address. An active
		// certificate changes the listener, never the supplied origin.
		const { doc } = compose(GITEA, {
			resources: SELECTED,
			appUrl: "https://git.example.com",
		});
		expect(doc.services["gitea-sidecar"]!.environment!.APP_URL).toBe(
			"https://git.example.com",
		);
		// The component-side address still reads the listener it belongs to.
		expect(doc.services["gitea-sidecar"]!.environment!.UPSTREAM).toBe(
			"https://gitea-gitea:3000",
		);
	});

	it("leaves an entry that binds no certificate alone", () => {
		const { yaml } = compose(GITEA, { resources: SELECTED });
		// The `ssh` entry is tcp and binds nothing; its published mapping is
		// untouched by an active certificate on the sibling entry.
		expect(yaml).toContain("22");
	});
});

describe("selected but unsatisfied refuses before launch (D-61 rule 5)", () => {
	for (const missing of ["cert_file", "key_file"] as const) {
		it(`refuses the component when only ${missing} is missing`, () => {
			const properties: Record<string, string> = {
				cert_file: CERT_PATH,
				key_file: KEY_PATH,
			};
			delete properties[missing];
			const { doc, warnings } = compose(GITEA, {
				resources: { "server-cert": { properties } },
			});
			const message = warnings.join("\n");
			expect(message).toContain("refused: gitea");
			expect(message).toContain('server-cert (endpoint "web")');
			expect(message).toContain(missing);
			// The refusal IS the removal: a component left in the file would
			// start cleartext on a listener every sibling addresses as TLS.
			expect(doc.services["gitea-gitea"]).toBeUndefined();
		});
	}

	it("never falls back to HTTP for the refused component", () => {
		const { doc } = compose(GITEA, {
			resources: { "server-cert": { properties: { cert_file: CERT_PATH } } },
		});
		expect(Object.keys(doc.services)).not.toContain("gitea-gitea");
		expect(Object.keys(doc.services)).toContain("gitea-sidecar");
	});

	it("treats an empty supplied value as missing, not as a path", () => {
		const { warnings } = compose(GITEA, {
			resources: {
				"server-cert": { properties: { cert_file: CERT_PATH, key_file: "" } },
			},
		});
		expect(warnings.join("\n")).toContain("key_file");
	});
});

describe("a supplied `key_file` never reaches a diagnostic (D-56 rule 5, CWE-532)", () => {
	/** One NDJSON line, built the way `shell.ts` builds its `shell exec` log. */
	function ndjsonShellLine(cmd: string, args: string[]): string {
		const lines: string[] = [];
		const stream = new Writable({
			write(chunk, _encoding, callback) {
				lines.push(chunk.toString().trim());
				callback();
			},
		});
		const log = pino(
			{
				level: "trace",
				base: { service: "launchfile-docker" },
				redact: { paths: [...REDACT_CONFIG.paths], censor: REDACT_CONFIG.censor },
			},
			stream,
		);
		log.debug({ cmd, args: args.map(redactSecrets) }, "shell exec");
		return lines.join("\n");
	}

	it("registers the key path with the redactor during generation", () => {
		compose(GITEA, { resources: SELECTED });
		expect(redactSecrets(`opening ${KEY_PATH} failed`)).toBe(
			`opening ${REDACTED} failed`,
		);
	});

	it("keeps the key path out of an NDJSON log line", () => {
		compose(GITEA, { resources: SELECTED });
		const line = ndjsonShellLine("docker", ["compose", "-f", KEY_PATH, "up"]);
		expect(line).not.toContain(KEY_PATH);
		expect(line).toContain(REDACTED);
	});

	it("keeps the key path out of a captured failure record", () => {
		compose(GITEA, { resources: SELECTED });
		const error = dockerLaunchError({
			phase: "provision",
			key: "gitea",
			component: "gitea",
			message: `tls: failed to load ${KEY_PATH}`,
			stderr: `open ${KEY_PATH}: permission denied`,
		});
		expect(JSON.stringify(error.context)).not.toContain(KEY_PATH);
	});

	it("leaves the certificate path readable — it is not key material", () => {
		compose(GITEA, { resources: SELECTED });
		// Redacting an address corrupts the diagnostic it exists to protect
		// (D-56 rule 5's structural exemption). `cert_file` is public material.
		expect(redactSecrets(`loading ${CERT_PATH}`)).toBe(`loading ${CERT_PATH}`);
	});
});

describe("one supplied entry serves every component that names it (D-56 keying)", () => {
	// `ComposeOpts.resources` is app-global and keyed by `name ?? type`, so two
	// components whose `supports:` entries share a name share the one supplied
	// certificate. D-61 rule 1 resolves the binding within a component, which
	// makes the file valid; the supply channel is where they meet. D-61 Left
	// open (4) — shared certificates are a validation error — holds WITHIN a
	// component, not across two.
	const PAIR = `
name: pair
components:
  alpha:
    image: alpha:1
    provides:
      - { name: web, protocol: http, port: 3000, exposed: true, tls: server-cert }
    supports:
      - name: server-cert
        type: certificate
        set_env:
          ALPHA_CERT_FILE: $cert_file
          ALPHA_KEY_FILE: $key_file
  beta:
    image: beta:1
    provides:
      # A distinct endpoint name: a provides name is app-wide (D-63 rule 4).
      - { name: api, protocol: http, port: 4000, exposed: true, tls: server-cert }
    supports:
      - name: server-cert
        type: certificate
        set_env:
          BETA_CERT_FILE: $cert_file
          BETA_KEY_FILE: $key_file
  reader:
    image: reader:1
    env:
      ALPHA: $components.alpha.url
      BETA: $components.beta.url
`;

	it("activates both bindings off the one supplied certificate", () => {
		const { doc } = compose(PAIR, { resources: SELECTED });
		expect(doc.services["pair-alpha"]!.environment!.ALPHA_CERT_FILE).toBe(CERT_PATH);
		expect(doc.services["pair-alpha"]!.environment!.ALPHA_KEY_FILE).toBe(KEY_PATH);
		expect(doc.services["pair-beta"]!.environment!.BETA_CERT_FILE).toBe(CERT_PATH);
		expect(doc.services["pair-beta"]!.environment!.BETA_KEY_FILE).toBe(KEY_PATH);
	});

	it("moves both effective listeners to `https`", () => {
		const { doc } = compose(PAIR, { resources: SELECTED });
		const env = doc.services["pair-reader"]!.environment!;
		expect(env.ALPHA).toBe("https://pair-alpha:3000");
		expect(env.BETA).toBe("https://pair-beta:4000");
	});

	it("leaves both on their declared baseline when nothing is supplied", () => {
		const { doc } = compose(PAIR);
		const env = doc.services["pair-reader"]!.environment!;
		expect(env.ALPHA).toBe("http://pair-alpha:3000");
		expect(env.BETA).toBe("http://pair-beta:4000");
		// Neither binding injected, so neither component carries an environment.
		expect(doc.services["pair-alpha"]!.environment).toBeUndefined();
		expect(doc.services["pair-beta"]!.environment).toBeUndefined();
	});
});

describe("output is unchanged for an app that declares no `tls:` (P-13)", () => {
	const PLAIN = `
name: plain
image: nginx:1
provides:
  - { name: web, protocol: http, port: 80, exposed: true }
`;

	it("is byte-identical with and without an unrelated supplied certificate", () => {
		const before = launchToCompose(readLaunch(PLAIN), {}).yaml;
		const after = launchToCompose(readLaunch(PLAIN), {
			resources: SELECTED,
		}).yaml;
		expect(after).toBe(before);
	});
});
