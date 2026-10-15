import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type ComposeOpts, launchToCompose } from "../compose-generator.js";

/**
 * Compose interpolates `$VAR`, `${VAR}` and `${VAR:-x}` in every string of
 * the file it reads, from the environment of the `docker compose` process,
 * and reads `$$` as a literal `$`. Every compose string built from Launchfile
 * text therefore carries each `$` it means literally as `$$`, so the host
 * environment never reaches the container (#776).
 */

interface ComposeService {
	command?: string;
	entrypoint?: string[];
	environment?: Record<string, string>;
	healthcheck?: { test: string[] };
}

type ComposeDoc = { services: Record<string, ComposeService> };

function generate(source: string, opts: ComposeOpts = {}) {
	const result = launchToCompose(readLaunch(source), opts);
	return { result, doc: parse(result.yaml) as ComposeDoc };
}

function serviceOf(doc: ComposeDoc, name: string): ComposeService {
	const service = doc.services[name];
	if (!service) throw new Error(`service ${name} missing from compose`);
	return service;
}

const PROBE = `
name: probe776
components:
  web:
    image: alpine:3
    env:
      HOME_BIN: "$$HOME_OF_WEB/bin"
      MIXED: "$$HOME_OF_WEB-$app.name"
    commands:
      start: 'sh -c "echo start $HOME_OF_WEB"'
    health:
      command: 'test -n "$HOME_OF_WEB"'
`;

function startCommand(start: string): string | undefined {
	const { doc } = generate(`
name: probe776
components:
  web:
    image: alpine:3
    commands:
      start: '${start}'
`);
	return serviceOf(doc, "probe776-web").command;
}

describe("shell slots carry the command text verbatim (D-12, then one compose escape)", () => {
	it("escapes a lone $VAR in commands.start, so the shell reads its own variable", () => {
		expect(startCommand('sh -c "echo start $HOME_OF_WEB"')).toBe(
			'sh -c "echo start $$HOME_OF_WEB"',
		);
	});

	it("keeps an author's $$VAR as $$VAR, which compose hands to the shell as $VAR", () => {
		expect(startCommand('nginx -g "upstream $${GATE_UPSTREAM_HOST}"')).toBe(
			'nginx -g "upstream $${GATE_UPSTREAM_HOST}"',
		);
		expect(startCommand("echo $$HOME_OF_WEB")).toBe("echo $$HOME_OF_WEB");
	});

	it("escapes ${VAR:-default}, so compose does not substitute the default either", () => {
		expect(startCommand('sh -c "echo ${HOME_OF_WEB:-none}"')).toBe(
			'sh -c "echo $${HOME_OF_WEB:-none}"',
		);
	});

	it("reads $$$ as $$ then $, which reaches the shell as $$ (its pid)", () => {
		expect(startCommand("echo $$$")).toBe("echo $$$$");
	});

	it("does not resolve Launchfile references in commands.start (#288 decides that)", () => {
		expect(startCommand("serve --url $app.url")).toBe("serve --url $$app.url");
	});

	it("leaves a command with no $ unchanged", () => {
		expect(startCommand("node server.js --port 3000")).toBe(
			"node server.js --port 3000",
		);
	});

	it("escapes a $ in health.command", () => {
		const { doc } = generate(PROBE);
		expect(serviceOf(doc, "probe776-web").healthcheck?.test).toEqual([
			"CMD-SHELL",
			'test -n "$$HOME_OF_WEB"',
		]);
	});

	it("escapes a $ in health.path inside the provider-built probe", () => {
		const { doc } = generate(`
name: probe776
components:
  web:
    image: alpine:3
    provides:
      - protocol: http
        port: 8080
    health:
      path: /ready?token=$HOME_OF_WEB
`);
		const probe = serviceOf(doc, "probe776-web").healthcheck?.test[1];
		expect(probe).toContain("http://localhost:8080/ready?token=$$HOME_OF_WEB ");
		expect(probe).not.toContain("$$$");
	});
});

describe("environment values carry each resolved $ as $$", () => {
	it("escapes the $ a $$ escape leaves in a mixed expression value", () => {
		const { doc } = generate(PROBE);
		expect(serviceOf(doc, "probe776-web").environment?.MIXED).toBe(
			"$$HOME_OF_WEB-probe776",
		);
	});

	it("keeps a literal $$VAR value as $$VAR (D-12 once, then one escape)", () => {
		const { doc } = generate(PROBE);
		expect(serviceOf(doc, "probe776-web").environment?.HOME_BIN).toBe(
			"$$HOME_OF_WEB/bin",
		);
	});

	it("escapes a $ in an operator-supplied required value", () => {
		const { doc } = generate(
			`
name: probe776
components:
  web:
    image: alpine:3
    env:
      API_KEY:
        required: true
`,
			{ operatorEnv: { API_KEY: "p$ss${word}" } },
		);
		expect(serviceOf(doc, "probe776-web").environment?.API_KEY).toBe(
			"p$$ss$${word}",
		);
	});

	it("escapes a $ in a supplied resource property that set_env resolves", () => {
		const { doc } = generate(
			`
name: probe776
components:
  web:
    image: alpine:3
    requires:
      - type: postgres
        set_env:
          DB_PASSWORD: $password
`,
			{ resources: { postgres: { properties: { password: "a$b" } } } },
		);
		expect(serviceOf(doc, "probe776-web").environment?.DB_PASSWORD).toBe(
			"a$$b",
		);
	});
});

describe("provider-authored compose strings are escaped once, by their author", () => {
	it("keeps the object-store entrypoint's $$1 as $$1", () => {
		const { doc } = generate(`
name: acme
components:
  app:
    image: acme/app:1
    requires:
      - type: minio
`);
		expect(serviceOf(doc, "acme-minio").entrypoint?.[2]).toBe(
			'mkdir -p "/data/$$1" && exec minio server /data',
		);
	});

	it("escapes $ELASTIC_PASSWORD in the elasticsearch healthcheck, so the container's password is used", () => {
		const { doc } = generate(`
name: acme
components:
  app:
    image: acme/app:1
    requires:
      - type: elasticsearch
`);
		expect(serviceOf(doc, "acme-elasticsearch").healthcheck?.test[1]).toBe(
			"curl -sf -u elastic:$$ELASTIC_PASSWORD http://localhost:9200/_cluster/health || exit 1",
		);
	});
});

/**
 * `docker compose config` interpolates without a daemon, so this runs
 * wherever the docker CLI and its compose plugin are installed. It prints a
 * literal `$` back as `$$`.
 */
const HAS_COMPOSE =
	spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

describe("round trip through docker compose config with a hostile host environment", () => {
	it.skipIf(!HAS_COMPOSE)(
		"never substitutes a host value into the file",
		() => {
			const { result } = generate(`
name: probe776
components:
  web:
    image: alpine:3
    env:
      HOME_BIN: "$$HOME_OF_WEB/bin"
      MIXED: "$$HOME_OF_WEB-$app.name"
    commands:
      start: 'sh -c "echo start $HOME_OF_WEB $$HOME_OF_WEB \${HOME_OF_WEB:-none}"'
    health:
      command: 'test -n "$HOME_OF_WEB"'
    requires:
      - type: elasticsearch
      - type: minio
`);
			const dir = mkdtempSync(join(tmpdir(), "lf-776-"));
			const file = join(dir, "docker-compose.yml");
			writeFileSync(file, result.yaml, { mode: 0o600 });

			const run = spawnSync(
				"docker",
				["compose", "-p", "lf776", "-f", file, "config", "--format", "json"],
				{
					encoding: "utf8",
					env: {
						...process.env,
						HOME_OF_WEB: "FROM_HOST",
						ELASTIC_PASSWORD: "FROM_HOST",
					},
				},
			);
			expect(run.status, run.stderr).toBe(0);
			expect(run.stdout).not.toContain("FROM_HOST");
			expect(run.stderr).not.toContain("variable is not set");

			const config = JSON.parse(run.stdout) as {
				services: Record<
					string,
					{
						command?: string[];
						environment?: Record<string, string>;
						healthcheck?: { test: string[] };
					}
				>;
			};
			const web = config.services["probe776-web"]!;
			expect(web.command).toEqual([
				"sh",
				"-c",
				"echo start $$HOME_OF_WEB $$HOME_OF_WEB $${HOME_OF_WEB:-none}",
			]);
			expect(web.healthcheck?.test).toEqual([
				"CMD-SHELL",
				'test -n "$$HOME_OF_WEB"',
			]);
			expect(web.environment).toMatchObject({
				HOME_BIN: "$$HOME_OF_WEB/bin",
				MIXED: "$$HOME_OF_WEB-probe776",
			});
			expect(
				config.services["probe776-elasticsearch"]?.healthcheck?.test[1],
			).toContain("elastic:$$ELASTIC_PASSWORD ");
		},
	);
});
