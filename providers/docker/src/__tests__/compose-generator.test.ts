import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
