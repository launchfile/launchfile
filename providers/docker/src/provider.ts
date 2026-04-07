/**
 * Main provider orchestration — docker compose lifecycle management.
 */

import { writeFile } from "node:fs/promises";
import { readLaunch } from "@launchfile/sdk";
import { checkPrereqs } from "./prereqs.js";
import { resolveSource } from "./source-resolver.js";
import {
	loadState,
	initState,
	saveState,
	ensureStateDir,
	composePath,
	composeProject,
	stateDir,
	stateBaseDir,
} from "./state.js";
import { allocatePorts } from "./port-allocator.js";
import { launchToCompose } from "./compose-generator.js";
import { shell } from "./shell.js";
import { readdir } from "node:fs/promises";

export interface DockerUpOpts {
	detach?: boolean;
	dryRun?: boolean;
}

export async function dockerUp(source: string, opts: DockerUpOpts = {}): Promise<void> {
	// 1. Check prerequisites
	if (!opts.dryRun) {
		console.log("Checking prerequisites...");
		const prereqs = await checkPrereqs();
		if (!prereqs.ok) {
			console.error("\nMissing prerequisites:");
			for (const m of prereqs.missing) console.error(`  - ${m}`);
			process.exit(1);
		}
	}

	// 2. Resolve source to Launchfile YAML
	console.log(`Resolving ${source}...`);
	const resolved = await resolveSource(source);
	console.log(`  Source: ${resolved.source} (${resolved.slug})`);

	// 3. Parse Launchfile
	const launch = readLaunch(resolved.yaml);
	console.log(`  App: ${launch.name}`);
	const componentNames = Object.keys(launch.components);
	console.log(`  Components: ${componentNames.join(", ")}`);

	// 4. Load or init state
	let state = await loadState(resolved.slug);
	if (!state) {
		state = initState(resolved.slug, launch.name, resolved.yaml);
	}
	await ensureStateDir(resolved.slug);

	// 5. Allocate host ports
	console.log("Allocating ports...");
	const hostPorts = await allocatePorts(launch.components, launch.name, state.ports);

	// 6. Generate compose
	console.log("Generating docker-compose.yml...");
	const result = launchToCompose(launch, {
		secrets: state.secrets,
		hostPorts,
	});

	// Log warnings
	for (const w of result.warnings) {
		console.warn(`  Warning: ${w}`);
	}

	// Update state
	state.secrets = result.secrets;
	state.ports = result.ports;

	if (opts.dryRun) {
		console.log("\n--- docker-compose.yml ---\n");
		console.log(result.yaml);
		printSummary(launch.name, result.ports);
		return;
	}

	// 7. Write compose file
	// Security: compose file contains passwords in environment variables
	const composeFile = composePath(resolved.slug);
	await writeFile(composeFile, result.yaml, { mode: 0o600 });
	console.log(`  Wrote ${composeFile}`);

	// 8. Save state
	await saveState(resolved.slug, state);

	// 9. Pull images
	const project = composeProject(resolved.slug);
	console.log("\nPulling images...");
	await shell(`docker compose -p ${project} -f "${composeFile}" pull`, { timeout: 300_000 });

	// 10. Start services
	console.log("\nStarting services...");
	await shell(`docker compose -p ${project} -f "${composeFile}" up -d`);

	// 11. Wait for health
	console.log("\nWaiting for services to be healthy...");
	const healthy = await waitForHealth(project, composeFile);
	if (!healthy) {
		console.warn("\nSome services may not be healthy yet. Check with: launchfile status");
	}

	// 12. Print summary
	printSummary(launch.name, result.ports);
	console.log(`\n  Stop:    launchfile down`);
	console.log(`  Destroy: launchfile down --destroy`);
	console.log(`  Logs:    launchfile logs --follow`);
}

export async function dockerDown(opts: { destroy?: boolean; slug?: string } = {}): Promise<void> {
	const slug = opts.slug ?? (await detectSlug());
	if (!slug) {
		console.error("No app specified and no active state found.");
		console.error("Usage: launchfile down [--destroy]");
		process.exit(1);
	}

	const state = await loadState(slug);
	if (!state) {
		console.error(`No state found for "${slug}".`);
		process.exit(1);
	}

	const project = composeProject(slug);
	const composeFile = composePath(slug);

	if (opts.destroy) {
		console.log(`Destroying ${state.appName}...`);
		await shell(`docker compose -p ${project} -f "${composeFile}" down -v --remove-orphans`, {
			allowFailure: true,
		});
		// Clean up state directory
		const { rm } = await import("node:fs/promises");
		await rm(stateDir(slug), { recursive: true, force: true });
		console.log("  Removed all containers, volumes, and state.");
	} else {
		console.log(`Stopping ${state.appName}...`);
		await shell(`docker compose -p ${project} -f "${composeFile}" down`, {
			allowFailure: true,
		});
		console.log("  Containers stopped. Data volumes preserved.");
		console.log("  Run `launchfile down --destroy` to remove everything.");
	}
}

export async function dockerStatus(slug?: string): Promise<void> {
	const resolved = slug ?? (await detectSlug());
	if (!resolved) {
		console.log("No active apps. Run `launchfile up <slug>` to start one.");
		return;
	}

	const state = await loadState(resolved);
	if (!state) {
		console.log(`No state found for "${resolved}".`);
		return;
	}

	const project = composeProject(resolved);
	const composeFile = composePath(resolved);

	console.log(`App: ${state.appName} (${resolved})`);
	console.log(`Created: ${state.createdAt}`);

	await shell(`docker compose -p ${project} -f "${composeFile}" ps`, { allowFailure: true });

	if (Object.keys(state.ports).length > 0) {
		console.log("\nAccess URLs:");
		for (const [name, port] of Object.entries(state.ports)) {
			console.log(`  ${name}: http://localhost:${port}`);
		}
	}
}

export async function dockerLogs(opts: { follow?: boolean; slug?: string } = {}): Promise<void> {
	const slug = opts.slug ?? (await detectSlug());
	if (!slug) {
		console.error("No app specified and no active state found.");
		process.exit(1);
	}

	const state = await loadState(slug);
	if (!state) {
		console.error(`No state found for "${slug}".`);
		process.exit(1);
	}

	const project = composeProject(slug);
	const composeFile = composePath(slug);
	const followFlag = opts.follow ? " --follow" : "";

	await shell(`docker compose -p ${project} -f "${composeFile}" logs${followFlag}`, {
		timeout: opts.follow ? 0 : 30_000,
	});
}

export async function dockerList(): Promise<void> {
	try {
		const base = stateBaseDir();
		const entries = await readdir(base, { withFileTypes: true });
		const dirs = entries.filter((e) => e.isDirectory());

		if (dirs.length === 0) {
			console.log("No managed apps. Run `launchfile up <slug>` to start one.");
			return;
		}

		console.log("Managed apps:\n");
		for (const dir of dirs) {
			const state = await loadState(dir.name);
			if (state) {
				const portList = Object.entries(state.ports)
					.map(([name, port]) => `${name}→:${port}`)
					.join(", ");
				console.log(`  ${dir.name} (${state.appName}) ${portList ? `[${portList}]` : ""}`);
			} else {
				console.log(`  ${dir.name} (no state)`);
			}
		}
	} catch {
		console.log("No managed apps. Run `launchfile up <slug>` to start one.");
	}
}

// --- Helpers ---

async function waitForHealth(project: string, composeFile: string): Promise<boolean> {
	const maxWait = 120_000; // 2 minutes
	const pollInterval = 3_000;
	const start = Date.now();

	while (Date.now() - start < maxWait) {
		const result = await shell(
			`docker compose -p ${project} -f "${composeFile}" ps --format json`,
			{ allowFailure: true, silent: true },
		);

		if (result.exitCode !== 0) {
			await new Promise((r) => setTimeout(r, pollInterval));
			continue;
		}

		// Parse container status — each line is a JSON object
		const lines = result.stdout.trim().split("\n").filter(Boolean);
		let allHealthy = true;
		let hasContainers = false;

		for (const line of lines) {
			try {
				const container = JSON.parse(line) as { State: string; Health: string; Name: string; Service: string };
				hasContainers = true;
				if (container.Health === "healthy" || container.Health === "") {
					// Healthy or no health check defined
					if (container.State !== "running") {
						allHealthy = false;
					}
				} else {
					allHealthy = false;
				}
			} catch {
				// Skip unparseable lines
			}
		}

		if (hasContainers && allHealthy) {
			console.log("  All services healthy.");
			return true;
		}

		process.stdout.write(".");
		await new Promise((r) => setTimeout(r, pollInterval));
	}

	console.log("");
	return false;
}

function printSummary(appName: string, ports: Record<string, number>): void {
	console.log("\n" + "=".repeat(50));
	console.log(`  ${appName} is running`);
	console.log("=".repeat(50));

	for (const [name, port] of Object.entries(ports)) {
		const label = name === "default" ? appName : name;
		console.log(`  ${label}: http://localhost:${port}`);
	}
}

/** Try to detect the current slug from the most recently updated state */
async function detectSlug(): Promise<string | null> {
	try {
		const base = stateBaseDir();
		const entries = await readdir(base, { withFileTypes: true });
		const dirs = entries.filter((e) => e.isDirectory());

		if (dirs.length === 0) return null;
		if (dirs.length === 1) return dirs[0]!.name;

		// If multiple, find most recently updated
		let latest: { name: string; time: string } | null = null;
		for (const dir of dirs) {
			const state = await loadState(dir.name);
			if (state && (!latest || state.updatedAt > latest.time)) {
				latest = { name: dir.name, time: state.updatedAt };
			}
		}
		return latest?.name ?? dirs[0]!.name;
	} catch {
		return null;
	}
}
