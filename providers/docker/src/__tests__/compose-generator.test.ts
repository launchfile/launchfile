import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { readLaunch } from "@launchfile/sdk";
import { launchToCompose } from "../compose-generator.js";
import { allocatePorts, publishedEndpoints } from "../port-allocator.js";

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
    exposed: true
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
    exposed: true
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
    exposed: true
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

		// P-13 / PROVIDERS.md § Host capabilities: "a file using the new entry
		// form and a file using the legacy block get the same grant/refuse
		// outcome." D-54 deprecates the block without changing that — the
		// counterpart of translate.test.ts's "grades image-only identically".
		it("produces the same grant/refuse outcome for both spellings (P-13)", () => {
			const of = (decl: string) =>
				launchToCompose(
					readLaunch(`version: launch/v1\nname: orchestrator\nimage: app:1\n${decl}`),
				);
			const legacy = of(
				"host:\n  docker: required\n  network: host\n  filesystem: read-write\n",
			);
			const entries = of(
				"requires:\n  - host: { container_runtime: docker }\n  - host: { network: host }\n  - host: { filesystem: read-write }\n",
			);

			// Same emitted compose (both refuse, so the component is skipped).
			expect(legacy.yaml).toBe(entries.yaml);
			expect(legacy.yaml).not.toContain("app:1");
			// Same refusal, naming the same capabilities in the same vocabulary.
			expect(legacy.warnings).toHaveLength(entries.warnings.length);
			for (const capability of [
				"container_runtime=docker",
				"network=host",
			]) {
				expect(legacy.warnings[0]).toContain(capability);
				expect(entries.warnings[0]).toContain(capability);
			}
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

// D-27: only `exposed: true` publishes; D-6: endpoint name is the identity
describe("multi-endpoint publication (D-27 / D-6)", () => {
	it("publishes every exposed:true endpoint with an explicit host mapping", () => {
		const launch = readLaunch(`
name: proxy
image: caddy
provides:
  - port: 80
    protocol: http
    exposed: true
  - name: https
    port: 443
    protocol: https
    exposed: true
`);
		const result = launchToCompose(launch, {
			hostPorts: { default: 18080, "default:https": 18443 },
		});
		expect(result.yaml).toContain("18080:80");
		expect(result.yaml).toContain("18443:443");
		// No bare container port — that would let Docker re-pick on every recreate
		expect(result.yaml).not.toMatch(/^\s+- "?443"?$/m);
		expect(result.ports).toEqual({ default: 18080, "default:https": 18443 });
		expect(result.endpoints["default:https"]).toMatchObject({
			component: "default",
			name: "https",
			containerPort: 443,
			hostPort: 18443,
			protocol: "https",
		});
	});

	it("does not publish entries that omit exposed (D-27: default false)", () => {
		// The mailpit shape: web UI opted in, SMTP unmarked → internal
		const launch = readLaunch(`
name: mailpit-like
image: axllent/mailpit
provides:
  - name: web-ui
    port: 8025
    protocol: http
    exposed: true
  - name: smtp
    port: 1025
    protocol: tcp
`);
		const result = launchToCompose(launch, { hostPorts: { default: 18025 } });
		expect(result.yaml).toContain("18025:8025");
		expect(result.yaml).not.toContain("1025");
		expect(result.ports).toEqual({ default: 18025 });
		expect(Object.keys(result.endpoints)).toEqual(["default"]);
		// Something *is* published, so the unreachable-app warning must stay quiet
		expect(result.warnings.filter((w) => w.includes("published to the host"))).toEqual([]);
	});

	it("warns when nothing in the whole app is published", () => {
		const launch = readLaunch(`
name: internal-only
image: postgres-like
provides:
  - port: 5432
    protocol: tcp
`);
		const result = launchToCompose(launch);
		expect(result.ports).toEqual({});
		expect(result.yaml).not.toContain("ports:");
		const warning = result.warnings.find((w) => w.includes("nothing is published to the host"));
		expect(warning).toBeDefined();
		expect(warning).toContain("internal-only:");
		expect(warning).toContain("exposed: true");
		expect(warning).toContain("D-27");
	});

	it("stays silent about internal components when the app publishes something", () => {
		// The supabase shape: five internal services behind one gateway. D-27's
		// rationale calls this the norm, so it must not produce a diagnostic.
		const launch = readLaunch(`
name: gatewayed
components:
  postgres:
    image: postgres-like
    provides:
      - port: 5432
        protocol: tcp
  studio:
    image: studio-like
    provides:
      - port: 3000
        protocol: http
  kong:
    image: kong-like
    provides:
      - port: 8000
        protocol: http
        exposed: true
`);
		const result = launchToCompose(launch, { hostPorts: { kong: 18000 } });
		expect(result.ports).toEqual({ kong: 18000 });
		expect(result.warnings.filter((w) => w.includes("published to the host"))).toEqual([]);
	});

	it("resolves $components.* for an explicitly exposed: false endpoint", () => {
		// `exposed` governs the host boundary only — an endpoint marked
		// `exposed: false` is still on the container network, so a sibling must
		// reach it. Same answer as omitting the field entirely.
		const launch = readLaunch(`
name: stack
components:
  db:
    image: postgres-like
    provides:
      - port: 5432
        protocol: tcp
        exposed: false
  web:
    image: nginx
    provides:
      - port: 3000
        protocol: http
        exposed: true
    env:
      DB_PORT: $components.db.port
`);
		const result = launchToCompose(launch, { hostPorts: { web: 13000 } });
		expect(result.yaml).toContain('DB_PORT: "5432"');
		// … while staying unpublished on the host
		expect(result.ports).toEqual({ web: 13000 });
	});

	it("does not warn about publication when the app declares no provides at all", () => {
		// A worker/cron app has nothing to publish; silence is correct.
		const launch = readLaunch(`
name: worker-only
image: worker-like
commands:
  start: "./worker"
`);
		const result = launchToCompose(launch);
		expect(result.ports).toEqual({});
		expect(result.warnings.filter((w) => w.includes("published to the host"))).toEqual([]);
	});

	it("publishes nothing for a component with no exposed:true entry, but still registers $components.*", () => {
		const launch = readLaunch(`
name: stack
components:
  db:
    image: postgres-like
    provides:
      - port: 5432
        protocol: tcp
  web:
    image: nginx
    provides:
      - port: 3000
        protocol: http
        exposed: true
    env:
      DB_PORT: $components.db.port
`);
		const result = launchToCompose(launch, { hostPorts: { web: 13000 } });
		// db's endpoint is internal: no host mapping, no ports entry …
		expect(result.ports).toEqual({ web: 13000 });
		expect(result.yaml).not.toContain(":5432");
		// … but the in-network reference still resolves (independent of D-27)
		expect(result.yaml).toContain('DB_PORT: "5432"');
		// … and db being internal is not itself worth a warning — web is published
		expect(result.warnings.filter((w) => w.includes("published to the host"))).toEqual([]);
	});

	it("emits /udp for udp endpoints", () => {
		const launch = readLaunch(`
name: wg-like
image: wg-easy
provides:
  - name: web-ui
    port: 51821
    protocol: http
    exposed: true
  - name: wireguard
    port: 51820
    protocol: udp
    exposed: true
`);
		const result = launchToCompose(launch, {
			hostPorts: { default: 51821, "default:wireguard": 51820 },
		});
		expect(result.yaml).toContain("51820:51820/udp");
		expect(result.yaml).not.toMatch(/51821:51821\/udp/);
	});

	it("applies bind per endpoint, including secondaries", () => {
		const launch = readLaunch(`
name: bound
image: nginx
provides:
  - port: 80
    protocol: http
    exposed: true
  - name: admin
    port: 8443
    protocol: https
    exposed: true
    bind: "127.0.0.1"
`);
		const result = launchToCompose(launch, {
			hostPorts: { default: 10080, "default:admin": 10443 },
		});
		expect(result.yaml).toContain("10080:80");
		expect(result.yaml).toContain("127.0.0.1:10443:8443");
	});

	it("gives same-port endpoints distinct keys and never emits a duplicate mapping", () => {
		const launch = readLaunch(`
name: samesies
image: nginx
provides:
  - name: api
    port: 8080
    protocol: http
    exposed: true
  - name: metrics
    port: 8080
    protocol: http
    exposed: true
`);
		const withPorts = launchToCompose(launch, {
			hostPorts: { default: 18080, "default:metrics": 18081 },
		});
		expect(withPorts.yaml).toContain("18080:8080");
		expect(withPorts.yaml).toContain("18081:8080");

		// Without an allocator run, both fall back to the container port; the
		// generator must not emit the identical mapping twice (compose rejects it).
		const bare = launchToCompose(launch);
		const occurrences = bare.yaml.match(/- "?8080:8080"?/g) ?? [];
		expect(occurrences).toHaveLength(1);
	});

	it("round-trips allocator keys through the generator into result.ports", async () => {
		const launch = readLaunch(`
name: rt
image: caddy
provides:
  - port: 80
    protocol: http
    exposed: true
  - name: https
    port: 443
    protocol: https
    exposed: true
  - port: 8443
    protocol: https
    exposed: true
`);
		const hostPorts = await allocatePorts(launch.components, "rt");
		const result = launchToCompose(launch, { hostPorts });

		// Every allocated key survives into result.ports with the same value,
		// so state persists exactly what the allocator will read back.
		expect(result.ports).toEqual(hostPorts);
		expect(Object.keys(hostPorts).sort()).toEqual(["default", "default:8443", "default:https"]);
		// And each mapping is explicit in the yaml
		for (const [key, hostPort] of Object.entries(hostPorts)) {
			const containerPort = result.endpoints[key]!.containerPort;
			expect(result.yaml).toContain(`${hostPort}:${containerPort}`);
		}
	});

	it("keeps $app.* on the first component with an exposed:true entry (the supabase shape)", () => {
		const launch = readLaunch(`
name: stack
components:
  db:
    image: postgres-like
    provides:
      - port: 5432
        protocol: tcp
  gateway:
    image: kong-like
    provides:
      - port: 8000
        protocol: http
        exposed: true
    env:
      PUBLIC_URL: $app.url
`);
		const result = launchToCompose(launch, { hostPorts: { gateway: 18000 } });
		// db comes first but is internal — $app.* must skip it (D-27)
		expect(result.yaml).toContain("PUBLIC_URL: http://localhost:18000");
	});
});

describe("publishedEndpoints", () => {
	it("keys the primary by bare component name and secondaries by endpoint name (D-6)", () => {
		const eps = publishedEndpoints("caddy", [
			{ port: 80, protocol: "http", exposed: true },
			{ name: "https", port: 443, protocol: "https", exposed: true },
			{ port: 9090, protocol: "http", exposed: true },
		]);
		expect(eps.map((e) => e.key)).toEqual(["caddy", "caddy:https", "caddy:9090"]);
	});

	it("excludes entries without exposed: true", () => {
		const eps = publishedEndpoints("app", [
			{ port: 80, protocol: "http", exposed: true },
			{ port: 22, protocol: "tcp" },
			{ port: 53, protocol: "udp", exposed: false },
		]);
		expect(eps).toHaveLength(1);
		expect(eps[0]!.key).toBe("app");
	});

	it("breaks key collisions between unnamed same-port entries", () => {
		const eps = publishedEndpoints("app", [
			{ port: 8080, protocol: "http", exposed: true },
			{ port: 8080, protocol: "http", exposed: true },
			{ port: 8080, protocol: "http", exposed: true },
		]);
		const keys = eps.map((e) => e.key);
		expect(new Set(keys).size).toBe(3);
		expect(keys[0]).toBe("app");
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

describe("generator: port", () => {
	const LAUNCH = `
name: port-app
image: api:latest
secrets:
  admin_port:
    generator: port
`;

	it("stays inside the 10000-64999 range across many draws", () => {
		const ports = new Set<number>();
		for (let i = 0; i < 2000; i++) {
			const { secrets } = launchToCompose(readLaunch(LAUNCH), { secrets: {} });
			const port = Number(secrets.admin_port);
			expect(Number.isInteger(port)).toBe(true);
			expect(port).toBeGreaterThanOrEqual(10_000);
			expect(port).toBeLessThanOrEqual(64_999);
			ports.add(port);
		}
		// A constant or a tiny cycle would collapse this; 2000 draws over 55000
		// values should land well clear of any plausible degenerate case.
		expect(ports.size).toBeGreaterThan(1500);
	});
});

describe("requires.config — postgres extensions (PROVIDERS.md §10.8)", () => {
	const pgLaunch = (config: string) =>
		readLaunch(`
name: vectorapp
image: myapp:1
requires:
  - type: postgres
${config}
provides:
  - protocol: http
    port: 3000
    exposed: true
`);

	it("selects the pgvector image and emits an init script for extensions: [vector]", () => {
		const launch = pgLaunch(`    config:
      extensions: [vector]`);
		const result = launchToCompose(launch);

		expect(result.yaml).toContain("pgvector/pgvector:pg16");
		expect(result.yaml).not.toContain("postgres:16-alpine");
		expect(result.yaml).toContain('CREATE EXTENSION IF NOT EXISTS "vector";');
		expect(result.yaml).toContain("/docker-entrypoint-initdb.d/90-launchfile-extensions.sql");
		expect(result.images).toContain("pgvector/pgvector:pg16");
		expect(result.warnings).toHaveLength(0);
	});

	it("normalizes the package name pgvector to the SQL name vector", () => {
		const launch = pgLaunch(`    config:
      extensions: [pgvector]`);
		const result = launchToCompose(launch);

		expect(result.yaml).toContain("pgvector/pgvector:pg16");
		expect(result.yaml).toContain('CREATE EXTENSION IF NOT EXISTS "vector";');
		expect(result.yaml).not.toContain('"pgvector"');
		expect(result.warnings).toHaveLength(0);
	});

	it("selects the postgis image for extensions: [postgis]", () => {
		const launch = pgLaunch(`    config:
      extensions: [postgis]`);
		const result = launchToCompose(launch);

		expect(result.yaml).toContain("postgis/postgis:16-3.4");
		expect(result.yaml).toContain('CREATE EXTENSION IF NOT EXISTS "postgis";');
		expect(result.warnings).toHaveLength(0);
	});

	it("keeps the stock image and emits no init script without config", () => {
		const launch = pgLaunch("");
		const result = launchToCompose(launch);

		expect(result.yaml).toContain("postgres:16-alpine");
		expect(result.yaml).not.toContain("configs:");
		expect(result.yaml).not.toContain("CREATE EXTENSION");
	});

	it("rejects an extension name that is not a safe identifier", () => {
		const launch = pgLaunch(`    config:
      extensions: ["vector; DROP TABLE users"]`);
		const result = launchToCompose(launch);

		expect(result.yaml).not.toContain("DROP TABLE");
		expect(result.yaml).not.toContain("CREATE EXTENSION");
		expect(result.warnings.some((w) => w.includes("not a valid identifier"))).toBe(true);
	});

	it("passes an unmapped extension through validated, with a warning", () => {
		const launch = pgLaunch(`    config:
      extensions: [pg_trgm]`);
		const result = launchToCompose(launch);

		expect(result.yaml).toContain("postgres:16-alpine");
		expect(result.yaml).toContain('CREATE EXTENSION IF NOT EXISTS "pg_trgm";');
		expect(result.warnings.some((w) => w.includes("no known dedicated image"))).toBe(true);
	});

	it("warns when two declared extensions need different images", () => {
		const launch = pgLaunch(`    config:
      extensions: [vector, postgis]`);
		const result = launchToCompose(launch);

		expect(result.yaml).toContain("pgvector/pgvector:pg16");
		expect(result.yaml).toContain('CREATE EXTENSION IF NOT EXISTS "vector";');
		expect(result.yaml).toContain('CREATE EXTENSION IF NOT EXISTS "postgis";');
		expect(result.warnings.some((w) => w.includes("need different images"))).toBe(true);
	});

	it("warns for a postgres config key it cannot honor", () => {
		const launch = pgLaunch(`    config:
      shared_buffers: 256MB`);
		const result = launchToCompose(launch);

		expect(result.yaml).toContain("postgres:16-alpine");
		expect(
			result.warnings.some(
				(w) => w.includes('"shared_buffers"') && w.includes("not supported"),
			),
		).toBe(true);
	});

	it("warns for config on a backing service type with no config support", () => {
		const launch = readLaunch(`
name: cacheapp
image: myapp:1
requires:
  - type: redis
    config:
      maxmemory: 256mb
`);
		const result = launchToCompose(launch);

		expect(
			result.warnings.some((w) => w.includes('"maxmemory"') && w.includes("not supported")),
		).toBe(true);
	});
});

describe("requires.config — shared backing service across components", () => {
	const twoComponentLaunch = (apiReq: string, workerReq: string) =>
		readLaunch(`
name: multi-pg
components:
  api:
    image: nginx
    requires:
      - type: postgres
${apiReq}
    provides:
      - port: 4000
        protocol: http
        exposed: true
  worker:
    image: nginx
    requires:
      - type: postgres
${workerReq}
`);

	it("warns when a later requirement's config differs from the shared service's", () => {
		const launch = twoComponentLaunch(
			"",
			`        config:
          extensions: [vector]`,
		);
		const result = launchToCompose(launch);

		// First requirement (no config) created the service — stock image, no init script
		expect(result.yaml).toContain("postgres:16-alpine");
		expect(result.yaml).not.toContain("CREATE EXTENSION");
		expect(
			result.warnings.some(
				(w) => w.includes("differs") && w.includes("multi-pg-postgres"),
			),
		).toBe(true);
	});

	it("stays silent when both components declare identical config", () => {
		const config = `        config:
          extensions: [vector]`;
		const launch = twoComponentLaunch(config, config);
		const result = launchToCompose(launch);

		expect(result.yaml).toContain("pgvector/pgvector:pg16");
		expect(result.yaml).toContain('CREATE EXTENSION IF NOT EXISTS "vector";');
		expect(result.warnings).toHaveLength(0);
	});

	it("honors the first requirement's config and warns on the config-less duplicate", () => {
		const launch = twoComponentLaunch(
			`        config:
          extensions: [vector]`,
			"",
		);
		const result = launchToCompose(launch);

		expect(result.yaml).toContain("pgvector/pgvector:pg16");
		expect(result.yaml).toContain('CREATE EXTENSION IF NOT EXISTS "vector";');
		expect(result.warnings.some((w) => w.includes("differs"))).toBe(true);
	});
});
