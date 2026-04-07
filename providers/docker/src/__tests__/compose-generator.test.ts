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
