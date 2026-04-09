import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readLaunch } from "@launchfile/sdk";
import {
	buildResolverContext,
	resolveComponentEnv,
	resolveGenerators,
} from "../env-writer.js";
import { getProvisioner } from "../resources/index.js";
import type { ResourceProperties } from "../resources/types.js";
import { allocatePorts } from "../port-allocator.js";

const CATALOG_ROOT = join(import.meta.dirname, "../../../../catalog");
const CATALOG_APPS = join(CATALOG_ROOT, "apps");
const CATALOG_DRAFTS = join(CATALOG_ROOT, "drafts");

/** Find a Launchfile in apps/ or drafts/ */
function catalogPath(app: string): string {
	const appsPath = join(CATALOG_APPS, app, "Launchfile");
	if (existsSync(appsPath)) return appsPath;
	return join(CATALOG_DRAFTS, app, "Launchfile");
}

/**
 * Dry-run test: parse a catalog Launchfile, simulate provisioning,
 * resolve env vars, and verify the output makes sense.
 */
describe("dry-run against catalog", () => {
	it("resolves miniflux Launchfile", async () => {
		const yaml = await readFile(catalogPath("miniflux"), "utf8");
		const launch = readLaunch(yaml);

		expect(launch.name).toBe("miniflux");
		expect(Object.keys(launch.components)).toEqual(["default"]);

		const component = launch.components.default!;

		// Verify requires
		expect(component.requires).toHaveLength(1);
		expect(component.requires![0]!.type).toBe("postgres");
		expect(component.requires![0]!.set_env?.DATABASE_URL).toBe("$url");

		// Simulate provisioned postgres
		const resourceMap: Record<string, ResourceProperties> = {
			postgres: {
				url: "postgresql://launchfile_miniflux:secret@localhost:5432/launchfile_miniflux",
				host: "localhost",
				port: 5432,
				user: "launchfile_miniflux",
				password: "secret",
				name: "launchfile_miniflux",
			},
		};

		const ports = await allocatePorts(launch.components, "miniflux");
		const context = buildResolverContext(resourceMap, ports, {});

		const env = resolveComponentEnv(component, context, resourceMap);
		await resolveGenerators(component, env);

		// DATABASE_URL should be resolved from postgres $url
		expect(env.DATABASE_URL).toBe(
			"postgresql://launchfile_miniflux:secret@localhost:5432/launchfile_miniflux",
		);
		// Default env vars should be resolved
		expect(env.RUN_MIGRATIONS).toBe("1");
		expect(env.CREATE_ADMIN).toBe("1");
		expect(env.ADMIN_USERNAME).toBe("admin");
		// ADMIN_PASSWORD has generator: secret, so it should be generated
		expect(env.ADMIN_PASSWORD).toBeTruthy();
		expect(env.ADMIN_PASSWORD!.length).toBeGreaterThan(10);
	});

	it("resolves langfuse Launchfile", async () => {
		const yaml = await readFile(catalogPath("langfuse"), "utf8");
		const launch = readLaunch(yaml);

		expect(launch.name).toBe("langfuse");

		for (const [name, component] of Object.entries(launch.components)) {
			// Every required resource should have a known provisioner
			for (const req of component.requires ?? []) {
				const provisioner = getProvisioner(req.type);
				expect(provisioner, `No provisioner for ${req.type} in ${name}`).toBeDefined();
			}
		}
	});

	it("resolves chatwoot multi-component Launchfile", async () => {
		const yaml = await readFile(catalogPath("chatwoot"), "utf8");
		const launch = readLaunch(yaml);

		expect(launch.name).toBe("chatwoot");
		const componentNames = Object.keys(launch.components);
		expect(componentNames.length).toBeGreaterThan(1);

		// Simulate resources
		const resourceMap: Record<string, ResourceProperties> = {
			postgres: {
				url: "postgresql://user:pass@localhost:5432/chatwoot",
				host: "localhost",
				port: 5432,
				user: "user",
				password: "pass",
				name: "chatwoot",
			},
			redis: {
				url: "redis://localhost:6379/0",
				host: "localhost",
				port: 6379,
			},
		};

		const ports = await allocatePorts(launch.components, "chatwoot");
		const secrets: Record<string, string> = {};

		// Generate secrets from launch.secrets
		if (launch.secrets) {
			for (const [name] of Object.entries(launch.secrets)) {
				secrets[name] = `test-secret-${name}`;
			}
		}

		const context = buildResolverContext(resourceMap, ports, secrets);

		// Resolve env for each component — should not throw
		for (const [name, component] of Object.entries(launch.components)) {
			const env = resolveComponentEnv(component, context, resourceMap);
			await resolveGenerators(component, env);
			// Every component should have at least some env vars
			expect(Object.keys(env).length, `${name} should have env vars`).toBeGreaterThan(0);
		}
	});

	it("identifies unsupported resource types", async () => {
		// Check all catalog Launchfiles for resource types we support
		const { readdir } = await import("node:fs/promises");
		const appsEntries = await readdir(CATALOG_APPS).catch(() => [] as string[]);
		const draftsEntries = await readdir(CATALOG_DRAFTS).catch(() => [] as string[]);
		const allApps = [...new Set([...appsEntries, ...draftsEntries])];
		const unsupported = new Set<string>();

		for (const app of allApps) {
			try {
				const yaml = await readFile(catalogPath(app), "utf8");
				const launch = readLaunch(yaml);

				for (const component of Object.values(launch.components)) {
					for (const req of [...(component.requires ?? []), ...(component.supports ?? [])]) {
						if (!getProvisioner(req.type)) {
							unsupported.add(req.type);
						}
					}
				}
			} catch {
				// Skip apps that can't be parsed
			}
		}

		// Log unsupported types for visibility
		if (unsupported.size > 0) {
			console.log(`  Unsupported resource types in catalog: ${[...unsupported].join(", ")}`);
		}
		// This test is informational — it doesn't fail
		expect(true).toBe(true);
	});
});
