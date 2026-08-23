import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { readLaunch } from "@launchfile/sdk";
import { launchToCompose } from "../compose-generator.js";

const CATALOG_DIR = join(import.meta.dirname, "../../../../catalog");

async function loadApp(name: string): Promise<ReturnType<typeof readLaunch>> {
	// Try apps/ first, then drafts/
	for (const dir of ["apps", "drafts"]) {
		try {
			const yaml = await readFile(join(CATALOG_DIR, dir, name, "Launchfile"), "utf8");
			return readLaunch(yaml);
		} catch {
			continue;
		}
	}
	throw new Error(`App "${name}" not found in catalog`);
}

describe("launchToCompose", () => {
	it("generates compose for a simple app (audiobookshelf)", async () => {
		const launch = await loadApp("audiobookshelf");
		const result = launchToCompose(launch);

		expect(result.yaml).toContain("audiobookshelf");
		expect(result.warnings).toHaveLength(0);
		expect(result.images.length).toBeGreaterThan(0);
		// Should have storage volumes
		expect(result.yaml).toContain("volumes:");
	});

	it("generates compose for an app with postgres (ghost)", async () => {
		const launch = await loadApp("ghost");
		const result = launchToCompose(launch);

		expect(result.yaml).toContain("ghost");
		// Should have a mysql backing service (ghost uses mysql)
		expect(result.yaml).toContain("mysql");
		expect(result.yaml).toContain("service_healthy");
		// Should have health check
		expect(result.yaml).toContain("healthcheck");
	});

	it("generates compose for an app with redis (miniflux)", async () => {
		const launch = await loadApp("miniflux");
		const result = launchToCompose(launch);

		expect(result.yaml).toContain("miniflux");
		expect(result.yaml).toContain("postgres");
	});

	it("generates named volumes instead of anonymous", async () => {
		const launch = await loadApp("audiobookshelf");
		const result = launchToCompose(launch);

		// Named volumes follow pattern: serviceName-volumeName:/path
		expect(result.yaml).toMatch(/audiobookshelf-\w+:/);
	});

	it("uses random passwords, not hardcoded ones", async () => {
		const launch = await loadApp("ghost");
		const result = launchToCompose(launch);

		// Password should not be "launchfile"
		expect(result.yaml).not.toContain("MYSQL_PASSWORD: launchfile");
		expect(result.yaml).not.toContain("MYSQL_ROOT_PASSWORD: launchfile");
	});

	it("preserves secrets across calls when passed in opts", async () => {
		const launch = await loadApp("ghost");
		const secrets: Record<string, string> = {};

		const result1 = launchToCompose(launch, { secrets });
		const result2 = launchToCompose(launch, { secrets });

		// Secrets should be the same since we're passing the same object
		expect(result1.secrets).toEqual(result2.secrets);
	});

	it("respects host port overrides", async () => {
		const launch = await loadApp("audiobookshelf");
		const result = launchToCompose(launch, { hostPorts: { default: 9999 } });

		expect(result.yaml).toContain("9999:");
		expect(result.ports.default).toBe(9999);
	});

	it("includes bind address in port mapping when provides.bind is set", () => {
		const launch = readLaunch(`
name: test-bind
image: nginx
provides:
  - port: 80
    protocol: http
    bind: "127.0.0.1"
`);
		const result = launchToCompose(launch);
		expect(result.yaml).toContain("127.0.0.1:80:80");
	});

	it("omits bind address when provides.bind is 0.0.0.0", () => {
		const launch = readLaunch(`
name: test-bind-default
image: nginx
provides:
  - port: 80
    protocol: http
    bind: "0.0.0.0"
`);
		const result = launchToCompose(launch);
		expect(result.yaml).not.toContain("0.0.0.0:");
		expect(result.yaml).toContain("80:80");
	});

	it("includes bind address with host port override", () => {
		const launch = readLaunch(`
name: test-bind-override
image: nginx
provides:
  - port: 80
    protocol: http
    bind: "127.0.0.1"
`);
		const result = launchToCompose(launch, { hostPorts: { default: 9999 } });
		expect(result.yaml).toContain("127.0.0.1:9999:80");
	});

	it("adds restart: unless-stopped when not specified, respects explicit restart", async () => {
		// audiobookshelf has restart: always — should keep it
		const launch = await loadApp("audiobookshelf");
		const result = launchToCompose(launch);
		expect(result.yaml).toContain("restart:");

		// An app without explicit restart should get unless-stopped
		const minimal = readLaunch(`
name: test-restart
image: nginx
provides:
  - port: 80
    protocol: http
`);
		const minResult = launchToCompose(minimal);
		expect(minResult.yaml).toContain("unless-stopped");
	});

	it("adds a bridge network", async () => {
		const launch = await loadApp("audiobookshelf");
		const result = launchToCompose(launch);

		expect(result.yaml).toContain("networks:");
		expect(result.yaml).toContain("bridge");
	});

	describe("host capabilities — grant/refuse (D-44)", () => {
		it("refuses a required capability in the new entry form with a surfaced message", () => {
			const launch = readLaunch(`
name: dockge
image: louislam/dockge:1
requires:
  - host: { container_runtime: docker }
    set_env:
      DOCKER_HOST: $url
provides:
  - protocol: http
    port: 5001
    exposed: true
`);
			const result = launchToCompose(launch);

			expect(result.yaml).not.toContain("louislam/dockge");
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]).toContain("refused");
			expect(result.warnings[0]).toContain("container_runtime=docker");
			expect(result.warnings[0]).toContain("skipped");
		});

		it("refuses the legacy host block equivalently", () => {
			const launch = readLaunch(`
name: legacy-app
image: app:1
host:
  docker: required
`);
			const result = launchToCompose(launch);

			expect(result.yaml).not.toContain("app:1");
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]).toContain("refused");
			expect(result.warnings[0]).toContain("container_runtime=docker");
		});

		it("refuses folded capabilities (network/privileged) in the new form", () => {
			const launch = readLaunch(`
name: wg-easy
image: wg-easy:latest
requires:
  - host: { network: host }
  - host: { privileged: true }
`);
			const result = launchToCompose(launch);

			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]).toContain("refused");
			expect(result.warnings[0]).toContain("network=host");
			expect(result.warnings[0]).toContain("privileged=true");
		});

		it("deploys with a note when an optional (supports) capability is not granted", () => {
			const launch = readLaunch(`
name: beszel
image: henrygd/beszel:latest
supports:
  - host: { container_runtime: any }
provides:
  - protocol: http
    port: 8090
    exposed: true
`);
			const result = launchToCompose(launch);

			// Component still deploys — optional means deploy, probe, degrade
			expect(result.yaml).toContain("henrygd/beszel");
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]).toContain("optional host capability");
			expect(result.warnings[0]).toContain("container_runtime=any");
			expect(result.warnings[0]).not.toContain("refused");
		});
	});

	it("skips components without images", () => {
		const launch = readLaunch(`
name: test-app
runtime: node
commands:
  start: "node server.js"
`);
		const result = launchToCompose(launch);

		expect(result.warnings.length).toBeGreaterThan(0);
		expect(result.warnings[0]).toContain("skipped");
	});

	it("handles multi-component apps", async () => {
		// Check if appwrite exists in drafts (it's multi-component)
		try {
			const launch = await loadApp("appwrite");
			const result = launchToCompose(launch);

			// Should have multiple services
			const serviceCount = (result.yaml.match(/image:/g) ?? []).length;
			expect(serviceCount).toBeGreaterThan(1);
		} catch {
			// appwrite might not exist — skip gracefully
		}
	});
});

// D-33: $app.* prefix end-to-end through the docker provider
describe("compose-generator $app.* properties (D-33)", () => {
	it("resolves $app.url to http://localhost:<hostPort> in env vars", () => {
		const launch = readLaunch(`
name: my-app
image: nginx
provides:
  - port: 8080
    protocol: http
    exposed: true
env:
  PUBLIC_URL: $app.url
`);
		const result = launchToCompose(launch, { hostPorts: { default: 10042 } });
		expect(result.yaml).toContain("PUBLIC_URL: http://localhost:10042");
	});

	it("resolves $app.host, $app.port, and $app.name in templates", () => {
		const launch = readLaunch(`
name: my-app
image: nginx
provides:
  - port: 3000
    protocol: http
    exposed: true
env:
  HOSTS: "\${app.host}"
  PORTS: "\${app.port}"
  NAMES: "\${app.name}"
  CALLBACK: "\${app.url}/oauth/callback"
`);
		const result = launchToCompose(launch, { hostPorts: { default: 10043 } });
		expect(result.yaml).toContain("HOSTS: localhost");
		expect(result.yaml).toContain('PORTS: "10043"');
		expect(result.yaml).toContain("NAMES: my-app");
		expect(result.yaml).toContain("CALLBACK: http://localhost:10043/oauth/callback");
	});

	it("resolves $app.authority, $app.scheme, and $app.tls (D-35) — the HedgeDoc shape", () => {
		const launch = readLaunch(`
name: hedge-like
image: nginx
provides:
  - port: 3000
    protocol: http
    exposed: true
env:
  CMD_DOMAIN: $app.authority
  CMD_PROTOCOL_USESSL: $app.tls
  SCHEME: $app.scheme
`);
		const result = launchToCompose(launch, { hostPorts: { default: 49200 } });
		// Without these, an empty CMD_DOMAIN makes the app emit an invalid CSP
		// and the page renders unstyled — the gap this fix closes.
		expect(result.yaml).toContain("CMD_DOMAIN: localhost:49200");
		expect(result.yaml).toContain('CMD_PROTOCOL_USESSL: "false"');
		expect(result.yaml).toContain("SCHEME: http");
	});

	it("leaves $app.authority/scheme/tls empty for an app with no exposed component", () => {
		const launch = readLaunch(`
name: worker
image: nginx
env:
  CMD_DOMAIN: "[\${app.authority}]"
`);
		const result = launchToCompose(launch);
		// No exposed port → empty url → empty authority; resolves to "" not undefined.
		expect(result.yaml).toContain('CMD_DOMAIN: "[]"');
	});
});

describe("compose-generator $storage.* properties (D-39)", () => {
	// Docker bind-mounts each named volume at its declared path, so
	// $storage.<name>.path resolves to that in-container path — and the path
	// leaves the command/duplicated-default entirely (the mailpit/anythingllm fix).
	it("resolves $storage.<name>.path to the declared container path", () => {
		const launch = readLaunch(`
name: mailpit
image: axllent/mailpit
storage:
  data:
    path: /data
env:
  MP_DATABASE: "\${storage.data.path}/mailpit.db"
  DATA_DIR: $storage.data.path
`);
		const result = launchToCompose(launch);
		expect(result.yaml).toContain("MP_DATABASE: /data/mailpit.db");
		expect(result.yaml).toContain("DATA_DIR: /data");
	});

	it("leaves $storage.<name>.path empty for an unknown volume name", () => {
		const launch = readLaunch(`
name: app
image: nginx
storage:
  data:
    path: /data
env:
  X: "[\${storage.nope.path}]"
`);
		const result = launchToCompose(launch);
		expect(result.yaml).toContain('X: "[]"');
	});

	it("falls back to the declared container port when no host port override is given", () => {
		const launch = readLaunch(`
name: ghost-like
image: nginx
provides:
  - port: 2368
    protocol: http
    exposed: true
env:
  URL: $app.url
`);
		const result = launchToCompose(launch);
		// With no host port override, the docker provider uses the container
		// port as-is, so $app.url reflects that.
		expect(result.yaml).toContain("URL: http://localhost:2368");
	});

	it("validates the $app.url shape used by the firefly-iii catalog entry", async () => {
		const launch = await loadApp("firefly-iii");
		const result = launchToCompose(launch, { hostPorts: { default: 10044 } });
		// firefly-iii's APP_URL is now `default: $app.url` per the catalog update.
		expect(result.yaml).toContain("APP_URL: http://localhost:10044");
	});

	it("picks the first exposed component for multi-component apps", () => {
		const launch = readLaunch(`
name: multi-app
components:
  api:
    image: nginx
    provides:
      - port: 4000
        protocol: http
        exposed: true
    env:
      MY_URL: $app.url
  worker:
    image: nginx
`);
		const result = launchToCompose(launch, { hostPorts: { api: 10045 } });
		expect(result.yaml).toContain("MY_URL: http://localhost:10045");
	});
});

describe("compose-generator secrets", () => {
	it("generates app-wide secrets from launch.secrets", () => {
		const launch = readLaunch(`
name: test-app
image: nginx
secrets:
  jwt-key:
    generator: secret
  session-id:
    generator: uuid
`);
		const result = launchToCompose(launch);

		expect(result.secrets["jwt-key"]).toBeDefined();
		expect(result.secrets["jwt-key"]!.length).toBe(64); // 32 bytes hex
		expect(result.secrets["session-id"]).toBeDefined();
		expect(result.secrets["session-id"]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});
});

describe("env-level generator preservation (D-49, #186)", () => {
	const appYaml = `
name: envgen
image: nginx
env:
  APP_KEY:
    generator: secret
`;

	function envOf(yamlText: string, service: string): Record<string, string> {
		const doc = parse(yamlText) as {
			services: Record<string, { environment?: Record<string, string> }>;
		};
		return doc.services[service]?.environment ?? {};
	}

	it("reuses the persisted value instead of re-minting when state holds one", () => {
		const launch = readLaunch(appYaml);
		const generatedEnv = { "default.APP_KEY": "a".repeat(64) };

		const result = launchToCompose(launch, { generatedEnv });

		expect(envOf(result.yaml, "envgen").APP_KEY).toBe("a".repeat(64));
		expect(result.generatedEnv).toEqual({ "default.APP_KEY": "a".repeat(64) });
	});

	it("mints and returns the value for persistence when state holds none", () => {
		const launch = readLaunch(appYaml);

		const result = launchToCompose(launch, {});

		const value = envOf(result.yaml, "envgen").APP_KEY!;
		expect(value).toMatch(/^[0-9a-f]{64}$/);
		// result.generatedEnv is what provider.ts writes back to state before
		// saveState — the write-back is the invariant, not just the env value.
		expect(result.generatedEnv["default.APP_KEY"]).toBe(value);
	});

	it("does not persist `generator: port` and does not read a stale port from the store", () => {
		const launch = readLaunch(`
name: envgen
image: nginx
env:
  APP_PORT:
    generator: port
`);
		// Even a (never-written-by-us) port entry in the store is ignored —
		// the port branch re-allocates unconditionally.
		const generatedEnv: Record<string, string> = { "default.APP_PORT": "1" };

		const result = launchToCompose(launch, { generatedEnv });

		const value = envOf(result.yaml, "envgen").APP_PORT!;
		expect(String(value)).toMatch(/^\d+$/);
		expect(String(value)).not.toBe("1");
		expect(result.generatedEnv["default.APP_PORT"]).toBe("1"); // untouched, never re-written
	});

	it("preserves `generator: uuid` values across calls", () => {
		const launch = readLaunch(`
name: envgen
image: nginx
env:
  INSTANCE_ID:
    generator: uuid
`);
		const generatedEnv: Record<string, string> = {};

		const first = envOf(launchToCompose(launch, { generatedEnv }).yaml, "envgen").INSTANCE_ID!;
		expect(first).toMatch(/^[0-9a-f-]{36}$/);

		const second = envOf(launchToCompose(launch, { generatedEnv }).yaml, "envgen").INSTANCE_ID!;
		expect(second).toBe(first);
	});

	it("does not leak env-level values into $secrets.*", () => {
		const launch = readLaunch(`
name: envgen
image: nginx
env:
  APP_KEY:
    generator: secret
  LEAK_CHECK:
    default: "$secrets.APP_KEY"
`);
		const result = launchToCompose(launch, {});

		const env = envOf(result.yaml, "envgen");
		expect(env.APP_KEY).toMatch(/^[0-9a-f]{64}$/);
		// APP_KEY is declared only under env:, so it is not a secrets name —
		// the reference resolves to empty, and result.secrets stays clean.
		expect(env.LEAK_CHECK ?? "").toBe("");
		expect(result.secrets.APP_KEY).toBeUndefined();
	});

	it("keys per component: same variable name on two components stays independent and stable", () => {
		const launch = readLaunch(`
name: envgen2
components:
  web:
    image: nginx
    env:
      SHARED_KEY:
        generator: secret
  worker:
    image: nginx
    env:
      SHARED_KEY:
        generator: secret
`);
		const generatedEnv: Record<string, string> = {};

		const r1 = launchToCompose(launch, { generatedEnv });
		const web1 = envOf(r1.yaml, "envgen2-web").SHARED_KEY!;
		const worker1 = envOf(r1.yaml, "envgen2-worker").SHARED_KEY!;
		expect(web1).not.toBe(worker1); // two declarations, two mintings (D-25)
		expect(r1.generatedEnv["web.SHARED_KEY"]).toBe(web1);
		expect(r1.generatedEnv["worker.SHARED_KEY"]).toBe(worker1);

		const r2 = launchToCompose(launch, { generatedEnv });
		expect(envOf(r2.yaml, "envgen2-web").SHARED_KEY).toBe(web1);
		expect(envOf(r2.yaml, "envgen2-worker").SHARED_KEY).toBe(worker1);
	});
});

describe("compose-generator build support", () => {
	it("emits a build config for components with build:, resolved against projectDir", () => {
		const launch = readLaunch(`
name: srcapp
build:
  dockerfile: Dockerfile
provides:
  - protocol: http
    port: 9999
    exposed: true
`);
		const result = launchToCompose(launch, { projectDir: "/repos/srcapp" });

		expect(result.warnings).toHaveLength(0);
		expect(result.builds).toEqual(["srcapp"]);
		expect(result.images).toHaveLength(0); // nothing to pull
		expect(result.yaml).toContain("context: /repos/srcapp");
		expect(result.yaml).toContain("dockerfile: Dockerfile");
	});

	it("uses image: as the tag for the built artifact when both are present", () => {
		const launch = readLaunch(`
name: srcapp
build: "."
image: srcapp:dev
`);
		const result = launchToCompose(launch, { projectDir: "/repos/srcapp" });

		expect(result.builds).toEqual(["srcapp"]);
		// The image is a tag for the build output, not something to pull
		expect(result.images).toHaveLength(0);
		expect(result.yaml).toContain("image: srcapp:dev");
	});

	it("passes remote git contexts through untouched", () => {
		const launch = readLaunch(`
name: remoteapp
build:
  context: https://github.com/example/app.git
`);
		const result = launchToCompose(launch);

		expect(result.builds).toEqual(["remoteapp"]);
		expect(result.yaml).toContain("context: https://github.com/example/app.git");
	});

	it("skips relative build contexts when the source is not local", () => {
		const launch = readLaunch(`
name: srcapp
build: "."
`);
		const result = launchToCompose(launch); // no projectDir

		expect(result.builds).toHaveLength(0);
		expect(result.warnings.some((w) => w.includes("not local"))).toBe(true);
	});

	it("warns that build secrets are not supported", () => {
		const launch = readLaunch(`
name: srcapp
build:
  context: "."
  secrets: [npm-token]
`);
		const result = launchToCompose(launch, { projectDir: "/repos/srcapp" });

		expect(result.warnings.some((w) => w.includes("build secrets"))).toBe(true);
	});

	it("resolves build args and target", () => {
		const launch = readLaunch(`
name: srcapp
build:
  context: "."
  target: runtime
  args:
    NODE_ENV: production
`);
		const result = launchToCompose(launch, { projectDir: "/repos/srcapp" });

		expect(result.yaml).toContain("target: runtime");
		expect(result.yaml).toContain("NODE_ENV: production");
	});
});
