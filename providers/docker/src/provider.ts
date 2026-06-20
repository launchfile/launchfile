/**
 * Main provider orchestration — docker compose lifecycle management.
 */

import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { readLaunch, selectComponents } from "@launchfile/sdk";
import { checkPrereqs, composeSupportsIgnoreBuildable } from "./prereqs.js";
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
import { shell, shellStream } from "./shell.js";
import { getLogger, withSpan } from "./logger.js";
import { readdir } from "node:fs/promises";

export interface DockerUpOpts {
	detach?: boolean;
	dryRun?: boolean;
	/** Skip confirmation prompt for remote Launchfiles */
	yes?: boolean;
	/**
	 * Component selector (#77): if non-empty, only these components are started.
	 * Their `requires` come along via compose `depends_on`; `depends_on` targets
	 * are NOT auto-added (satisfy-not-expand). Empty = all components.
	 */
	components?: string[];
}

/** component name → compose service name (mirrors compose-generator). */
function serviceNameFor(appName: string, componentName: string): string {
	return componentName === "default" ? appName : `${appName}-${componentName}`;
}

/**
 * Identity + source information for a docker deployment, returned to the
 * caller so the unified CLI keys its deployment index by the SAME slug the
 * docker provider uses (#48), and can re-locate the Launchfile later (#25).
 */
export interface DockerUpResult {
	slug: string;
	appName: string;
	sourceType: "local" | "catalog" | "url";
	/** Absolute Launchfile path for local sources; undefined otherwise. */
	sourcePath?: string;
	/** Original URL for url sources; undefined otherwise. */
	sourceUrl?: string;
}

export async function dockerUp(source: string, opts: DockerUpOpts = {}): Promise<DockerUpResult> {
	// Resolve source before the span so we have the slug for span context
	const resolved = await resolveSource(source);

	return withSpan("up", { source, slug: resolved.slug }, async () => {
		const log = getLogger();

		// Check prerequisites
		if (!opts.dryRun) {
			const prereqs = await checkPrereqs();
			if (!prereqs.ok) {
				console.error("\nMissing prerequisites:");
				for (const m of prereqs.missing) console.error(`  - ${m}`);
				process.exit(1);
			}
		}

		// Parse Launchfile
		const launch = readLaunch(resolved.yaml);
		const componentNames = Object.keys(launch.components);

		// Resolve component selector (#77). Empty = all components.
		const selection = selectComponents(launch, opts.components ?? []);
		if (selection.unknown.length > 0 || selection.resources.length > 0) {
			console.error(`\nCannot select: ${[...selection.unknown, ...selection.resources].join(", ")}`);
			for (const r of selection.resources) {
				console.error(`  - "${r}" is a backing resource, not a component; select the component that requires it.`);
			}
			for (const u of selection.unknown) {
				console.error(`  - "${u}" matches no component. Available: ${componentNames.join(", ")}`);
			}
			process.exit(1);
		}
		const selectedServices =
			opts.components && opts.components.length > 0
				? selection.selected.map((name) => serviceNameFor(launch.name, name))
				: [];

		// Security: prompt for confirmation before executing remote Launchfiles.
		// Remote content can specify arbitrary images, commands, and env vars.
		if (resolved.source !== "local" && !opts.yes && !opts.dryRun) {
			const resources = componentNames.flatMap((name) => {
				const comp = launch.components[name];
				return (comp?.requires ?? []).map((r) => r.type);
			});
			const images = componentNames
				.map((name) => launch.components[name]?.image)
				.filter(Boolean) as string[];
			const buildComponents = componentNames.filter(
				(name) => launch.components[name]?.build,
			);

			console.log(`  App: ${launch.name} (${resolved.slug})`);
			if (resources.length) console.log(`  Resources: ${resources.join(", ")}`);
			if (images.length) console.log(`  Images: ${images.join(", ")}`);
			if (buildComponents.length) console.log(`  Builds from source: ${buildComponents.join(", ")}`);
			console.log("");

			const confirmed = await confirm("  Proceed? [Y/n] ");
			if (!confirmed) {
				console.log("Aborted.");
				process.exit(0);
			}
		}

		// Persisted source info (#25): records where the Launchfile came from
		// so bootstrap/inspect can re-read it independent of the caller's cwd.
		const sourceInfo = {
			sourceType: resolved.source,
			sourcePath: resolved.source === "local" ? resolved.path : undefined,
			sourceUrl: resolved.source === "url" ? resolved.url : undefined,
		};

		// Load or init state
		let state = await loadState(resolved.slug);
		if (!state) {
			state = initState(resolved.slug, launch.name, resolved.yaml, sourceInfo);
		} else {
			// Backfill/refresh source info on existing state (older state files
			// predate these fields; a re-`up` from a new location updates them).
			state.sourceType = sourceInfo.sourceType;
			state.sourcePath = sourceInfo.sourcePath;
			state.sourceUrl = sourceInfo.sourceUrl;
		}
		await ensureStateDir(resolved.slug);

		// Allocate host ports
		const hostPorts = await allocatePorts(launch.components, launch.name, state.ports);

		// Generate compose
		const result = launchToCompose(launch, {
			secrets: state.secrets,
			hostPorts,
			projectDir: resolved.dir,
		});

		// Log warnings
		for (const w of result.warnings) {
			log.warn({ warning: w }, "compose generation warning");
			console.warn(`  Warning: ${w}`);
		}

		// Update state
		state.secrets = result.secrets;
		state.ports = result.ports;

		const upResult: DockerUpResult = {
			slug: resolved.slug,
			appName: launch.name,
			sourceType: sourceInfo.sourceType,
			sourcePath: sourceInfo.sourcePath,
			sourceUrl: sourceInfo.sourceUrl,
		};

		if (opts.dryRun) {
			console.log("\n--- docker-compose.yml ---\n");
			console.log(result.yaml);
			printSummary(launch.name, result.ports);
			return upResult;
		}

		// Write compose file
		await withSpan("up:compose", { slug: resolved.slug }, async () => {
			// Security: compose file contains passwords in environment variables
			const file = composePath(resolved.slug);
			await writeFile(file, result.yaml, { mode: 0o600 });
		});

		// Save state
		await saveState(resolved.slug, state);

		const project = composeProject(resolved.slug);
		const composeFile = composePath(resolved.slug);

		// Pull images for services that don't build from source
		if (result.images.length > 0) {
			await withSpan("up:pull", { images: result.images }, async () => {
				const t0 = Date.now();
				process.stdout.write(`  \u2193 Pulling ${result.images.join(", ")}...`);
				const pullArgs = ["compose", "-p", project, "-f", composeFile, "pull", "--quiet"];
				// Don't try to pull images that compose will build locally.
				// --ignore-buildable needs Compose >= 2.18; older installs get
				// --ignore-pull-failures so locally-built tags don't abort the pull.
				if (result.builds.length > 0) {
					pullArgs.push((await composeSupportsIgnoreBuildable()) ? "--ignore-buildable" : "--ignore-pull-failures");
				}
				await shell("docker", pullArgs, {
					timeout: 300_000,
					silent: true,
				});
				const sec = Math.round((Date.now() - t0) / 1000);
				console.log(` done (${sec}s)`);
			});
		}

		// Build images for services with a build: config. Source builds run
		// inside docker build — nothing from the repo executes on the host.
		if (result.builds.length > 0) {
			await withSpan("up:build", { services: result.builds }, async () => {
				const t0 = Date.now();
				console.log(`  \u2193 Building from source: ${result.builds.join(", ")} (this can take a few minutes)`);
				// One invocation builds all services concurrently under BuildKit
				// with a shared layer cache; output streams so the user sees
				// progress instead of silence (and no maxBuffer ceiling).
				await shellStream("docker", ["compose", "-p", project, "-f", composeFile, "build", ...result.builds], {
					timeout: 1_800_000,
				});
				const sec = Math.round((Date.now() - t0) / 1000);
				console.log(`  \u2713 Built ${result.builds.join(", ")} (${sec}s)`);
			});
		}

		// Configure resources (if any)
		const resources = componentNames.flatMap((name) => {
			const comp = launch.components[name];
			return (comp?.requires ?? []).map((r) => r.type);
		});
		for (const res of resources) {
			console.log(`  \u2193 Configuring ${res}... done`);
		}

		// Wire env vars (if any resources)
		if (resources.length > 0) {
			console.log(`  \u2193 Wiring environment variables... done`);
		}

		// Start services
		await withSpan("up:start", { project }, async () => {
			process.stdout.write(`  \u2193 Starting services...`);
			// Selected services start with their compose `depends_on` (resources)
			// pulled in automatically; non-selected components stay down (#77).
			await shell(
				"docker",
				["compose", "-p", project, "-f", composeFile, "up", "-d", ...selectedServices],
				{ silent: true },
			);
			console.log("");
		});

		// Wait for health
		await withSpan("up:health", { project }, async () => {
			const healthy = await waitForHealth(project, composeFile);
			if (healthy) {
				console.log(`  \u2713 Health check passed`);
			} else {
				log.warn({ project }, "health check timed out — some services may not be healthy");
				console.warn("  ! Some services may not be healthy yet. Check with: launchfile status");
			}
		});

		// Print summary
		printSummary(launch.name, result.ports);

		return upResult;
	});
}

export async function dockerDown(opts: { destroy?: boolean; slug?: string } = {}): Promise<void> {
	const slug = opts.slug ?? (await detectSlug());
	if (!slug) {
		console.error("No app specified and no active state found.");
		console.error("Usage: launchfile down [--destroy]");
		process.exit(1);
	}

	return withSpan("down", { slug, destroy: opts.destroy ?? false }, async () => {
		const state = await loadState(slug);
		if (!state) {
			console.error(`No state found for "${slug}".`);
			process.exit(1);
		}

		const project = composeProject(slug);
		const composeFile = composePath(slug);

		if (opts.destroy) {
			console.log(`Destroying ${state.appName}...`);
			await shell("docker", ["compose", "-p", project, "-f", composeFile, "down", "-v", "--remove-orphans"], {
				allowFailure: true,
			});
			// Clean up state directory
			const { rm } = await import("node:fs/promises");
			await rm(stateDir(slug), { recursive: true, force: true });
			console.log("  Removed all containers, volumes, and state.");
		} else {
			console.log(`Stopping ${state.appName}...`);
			await shell("docker", ["compose", "-p", project, "-f", composeFile, "down"], {
				allowFailure: true,
			});
			console.log("  Containers stopped. Data volumes preserved.");
			console.log("  Run `launchfile down --destroy` to remove everything.");
		}
	});
}

export async function dockerStatus(slug?: string): Promise<void> {
	const resolved = slug ?? (await detectSlug());
	if (!resolved) {
		console.log("No active apps. Run `launchfile up <slug>` to start one.");
		return;
	}

	return withSpan("status", { slug: resolved }, async () => {
		const state = await loadState(resolved);
		if (!state) {
			console.log(`No state found for "${resolved}".`);
			return;
		}

		const project = composeProject(resolved);
		const composeFile = composePath(resolved);

		console.log(`App: ${state.appName} (${resolved})`);
		console.log(`Created: ${state.createdAt}`);

		await shell("docker", ["compose", "-p", project, "-f", composeFile, "ps"], { allowFailure: true });

		if (Object.keys(state.ports).length > 0) {
			console.log("\nAccess URLs:");
			for (const [name, port] of Object.entries(state.ports)) {
				console.log(`  ${name}: http://localhost:${port}`);
			}
		}
	});
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
	const followArgs = opts.follow ? ["--follow"] : [];

	await shell("docker", ["compose", "-p", project, "-f", composeFile, "logs", ...followArgs], {
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
	const log = getLogger();
	const maxWait = 120_000; // 2 minutes
	const pollInterval = 3_000;
	const start = Date.now();

	while (Date.now() - start < maxWait) {
		const elapsed = Date.now() - start;
		log.trace({ elapsed, project }, "health poll");

		const result = await shell(
			"docker", ["compose", "-p", project, "-f", composeFile, "ps", "--format", "json"],
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
			return true;
		}

		await new Promise((r) => setTimeout(r, pollInterval));
	}

	return false;
}

function printSummary(appName: string, ports: Record<string, number>): void {
	console.log("");
	for (const [name, port] of Object.entries(ports)) {
		const label = name === "default" ? appName : name;
		console.log(`  ${label} is running at http://localhost:${port}`);
	}
}

/** Prompt user for yes/no confirmation via stdin */
function confirm(prompt: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() !== "n");
		});
	});
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
