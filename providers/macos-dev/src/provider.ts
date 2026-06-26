/**
 * Main provider orchestration — the `launch up` sequence.
 *
 * Reads a Launchfile, provisions resources, resolves env vars,
 * installs runtimes, and starts all components.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readLaunch, type NormalizedLaunch, type NormalizedComponent } from "@launchfile/sdk";

/**
 * Source-mode run resolution (D-38, precedence `dev` > `image` > `start`).
 * This provider runs apps from source. A component is source-runnable when it
 * declares `dev`, or a `start` with no `image` — an `image` without a `dev`
 * override stays artifact-mode, which this source-only provider can't launch.
 */
export function isSourceRunnable(component: NormalizedComponent): boolean {
	return Boolean(component.commands?.dev || (component.commands?.start && !component.image));
}

/** The command run from source, or undefined if the component resolves to its artifact. */
export function sourceRunCommand(component: NormalizedComponent): string | undefined {
	if (component.commands?.dev?.command) return component.commands.dev.command;
	if (component.image) return undefined; // image, no `dev` override → artifact
	return component.commands?.start?.command;
}
import { checkPrereqs } from "./prereqs.js";
import { loadState, initState, saveState, ensureDirs } from "./state.js";
import {
	buildResolverContext,
	computeAppProperties,
	resolveComponentEnv,
	generateSecrets,
	resolveGenerators,
	writeEnvFile,
} from "./env-writer.js";
import { getProvisioner, type ResourceProperties } from "./resources/index.js";
import { allocatePorts } from "./port-allocator.js";
import { getRuntimeInstaller } from "./runtimes/index.js";
import { detectPackageManager } from "./lockfile-detect.js";
import { provisionStorage } from "./storage.js";
import { ProcessManager } from "./process-manager.js";
import { stopRecordedProcesses } from "./process-stopper.js";
import { shell } from "./shell.js";
import { parseDuration } from "./bootstrap.js";

export interface LaunchUpOpts {
	withOptional?: boolean;
	noBuild?: boolean;
	detach?: boolean;
	dryRun?: boolean;
	projectDir?: string;
}

export async function launchUp(opts: LaunchUpOpts = {}): Promise<void> {
	const projectDir = opts.projectDir ?? process.cwd();

	// 1. Check prerequisites
	const prereqs = await checkPrereqs();
	if (!prereqs.ok) {
		console.error("Missing prerequisites:");
		for (const m of prereqs.missing) console.error(`  - ${m}`);
		process.exit(1);
	}

	// 2. Read and parse Launchfile
	const launchfilePath = join(projectDir, "Launchfile");
	let launchfileContent: string;
	try {
		launchfileContent = await readFile(launchfilePath, "utf8");
	} catch {
		console.error(`No Launchfile found at ${launchfilePath}`);
		process.exit(1);
	}

	const launch = readLaunch(launchfileContent);
	const componentNames = Object.keys(launch.components);

	// 2b. Source-mode guard (D-38) — fail fast before provisioning anything.
	// Run precedence is `dev` > `image` > `start`: a component runs from source
	// when it declares `dev`, or a `start` with no `image`. An `image` without a
	// `dev` override stays artifact-mode — which this source-only provider can't
	// launch. If nothing is source-runnable, the app belongs on `launchfile up`.
	const sourceRunnable = Object.values(launch.components).filter(isSourceRunnable);
	if (sourceRunnable.length === 0) {
		const hasImage = Object.values(launch.components).some((c) => c.image);
		console.error("Nothing to run from source: no component declares `dev` (or a `start` without an `image`).");
		console.error(
			hasImage
				? "This app runs from an image — use `launchfile up` to launch the built artifact."
				: "Add a `dev` (or `start`) command to run it from source.",
		);
		process.exit(1);
	}
	// Mixed app: warn about artifact components (image, no `dev` override) that
	// this source-only provider can't launch — they need `launchfile up`.
	for (const [name, c] of Object.entries(launch.components)) {
		if (!isSourceRunnable(c) && c.image) {
			console.warn(
				`  ! [${name}] has an image and no \`dev\` override — runs as an artifact, ` +
					"skipped in source mode; use `launchfile up` to run it.",
			);
		}
	}

	// 3. Load or init state
	let state = await loadState(projectDir);
	if (!state) {
		state = initState(launch.name, launchfileContent);
	}

	// 4. Ensure directories
	await ensureDirs(projectDir);

	// 5. Generate secrets
	state.secrets = await generateSecrets(launch.secrets, state.secrets);

	// 6. Provision required resources
	const resourceMap: Record<string, ResourceProperties> = {};

	for (const [_compName, component] of Object.entries(launch.components)) {
		for (const req of component.requires ?? []) {
			const resourceName = req.name ?? req.type;
			if (resourceMap[resourceName]) continue; // Already provisioned

			const provisioner = getProvisioner(req.type);
			if (!provisioner) {
				console.warn(`  ! No provisioner for resource type: ${req.type} (skipping)`);
				continue;
			}

			if (opts.dryRun) {
				console.log(`  [dry-run] Would provision ${req.type} as "${resourceName}"`);
				resourceMap[resourceName] = { url: "", host: "localhost", port: 0 }; // placeholder for dedup
				continue;
			}

			process.stdout.write(`  \u2193 Provisioning ${req.type}...`);
			const existing = state.resources[resourceName];
			const result = await provisioner.provision(req, { appName: launch.name, projectDir }, existing);
			resourceMap[resourceName] = result.properties;
			state.resources[resourceName] = result.state;
			console.log(" done");
		}

		// Optional supports resources
		if (opts.withOptional) {
			for (const sup of component.supports ?? []) {
				const resourceName = sup.name ?? sup.type;
				if (resourceMap[resourceName]) continue;

				const provisioner = getProvisioner(sup.type);
				if (!provisioner) continue;

				if (opts.dryRun) {
					console.log(`  [dry-run] Would provision optional ${sup.type} as "${resourceName}"`);
					resourceMap[resourceName] = { url: "", host: "localhost", port: 0 };
					continue;
				}

				try {
					process.stdout.write(`  \u2193 Provisioning ${sup.type} (optional)...`);
					const existing = state.resources[resourceName];
					const result = await provisioner.provision(sup, { appName: launch.name, projectDir }, existing);
					resourceMap[resourceName] = result.properties;
					state.resources[resourceName] = result.state;
					console.log(" done");
				} catch {
					console.log(" skipped");
				}
			}
		}
	}

	// 7. Allocate ports
	const componentPorts = await allocatePorts(launch.components, launch.name, state.ports);
	state.ports = componentPorts;

	// 8. Build resolver context (including $app.* properties from D-33)
	const appProperties = computeAppProperties(launch, componentPorts);
	const context = buildResolverContext(resourceMap, componentPorts, state.secrets, appProperties);

	// 9. Install runtimes
	for (const [name, component] of Object.entries(launch.components)) {
		if (!component.runtime) {
			if (!component.image) {
				console.warn(`  ! [${name}] No runtime declared — cannot run natively`);
			}
			continue;
		}

		const installer = getRuntimeInstaller(component.runtime);
		if (!installer) {
			console.warn(`  ! [${name}] No installer for runtime: ${component.runtime}`);
			continue;
		}

		if (opts.dryRun) {
			console.log(`  [dry-run] Would install runtime: ${component.runtime}`);
			continue;
		}

		const version = await installer.detectVersion(projectDir);
		if (version) {
			console.log(`  \u2193 Installing ${component.runtime} ${version}... done`);
			await installer.install(version);
		} else {
			console.log(`  \u2193 Using system ${component.runtime}`);
		}
	}

	// 10. Detect package manager
	const pm = await detectPackageManager(projectDir);

	// 11. Create storage directories
	for (const [name, component] of Object.entries(launch.components)) {
		await provisionStorage(component.storage, name, projectDir);
	}

	// 12. Resolve env vars and write .env files
	const allEnvs: Record<string, Record<string, string>> = {};
	const isSingleComponent = componentNames.length === 1 && componentNames[0] === "default";

	for (const [name, component] of Object.entries(launch.components)) {
		const env = resolveComponentEnv(component, context, resourceMap);
		await resolveGenerators(component, env);

		const port = componentPorts[name];
		if (port && !env.PORT) {
			env.PORT = String(port);
		}

		allEnvs[name] = env;

		if (opts.dryRun) {
			console.log(`  [dry-run] Env for ${name}: ${Object.keys(env).join(", ")}`);
			continue;
		}

		if (isSingleComponent) {
			await writeEnvFile(join(projectDir, ".env.local"), env);
			console.log(`  \u2193 Wiring environment variables... done (${Object.keys(env).length} vars)`);
		} else {
			const { mkdir } = await import("node:fs/promises");
			await mkdir(join(projectDir, ".launchfile", "env"), { recursive: true });
			await writeEnvFile(join(projectDir, ".launchfile", "env", `${name}.env`), env);
			console.log(`  \u2193 Wiring ${name} environment... done (${Object.keys(env).length} vars)`);
		}
	}

	// 13. Save state before build (in case build fails, we still have resource state)
	await saveState(projectDir, state);

	if (opts.dryRun) {
		console.log("\n[dry-run] Would now run build, release, and start commands.");
		printSummary(launch, componentPorts, resourceMap);
		return;
	}

	// 14. Run source-mode prepare \u2014 `install ?? build` (D-38), on demand
	if (!opts.noBuild) {
		for (const [name, component] of Object.entries(launch.components)) {
			const prepare = component.commands?.install ?? component.commands?.build;
			const cmd = prepare?.command ?? pm?.installCommand;
			if (cmd) {
				console.log(`  \u2193 Preparing${componentNames.length > 1 ? ` [${name}]` : ""}...`);
				await shell(cmd, {
					cwd: join(projectDir, component.source ?? component.build?.context ?? "."),
					env: allEnvs[name],
					// Installs/compiles routinely exceed the 2-minute shell default;
					// honor a declared timeout, else allow 10 minutes.
					timeout: prepare?.timeout ? parseDuration(prepare.timeout) : 600_000,
				});
			}
		}
	}

	// 15. Run release commands (migrations) \u2014 mode-invariant (D-38)
	for (const [name, component] of Object.entries(launch.components)) {
		const release = component.commands?.release;
		if (release?.command) {
			console.log(`  \u2193 Running release${componentNames.length > 1 ? ` [${name}]` : ""}...`);
			await shell(release.command, {
				cwd: join(projectDir, component.source ?? component.build?.context ?? "."),
				env: allEnvs[name],
				timeout: release.timeout ? parseDuration(release.timeout) : undefined,
			});
		}
	}

	// 16. Run components from source \u2014 `dev` over `start` (D-38; this provider ignores `image`)
	process.stdout.write(`  \u2193 Starting services...`);
	const pm2 = new ProcessManager(projectDir);

	for (const [name, component] of Object.entries(launch.components)) {
		// Resolve the source-mode run command (D-38 precedence `dev` > `image` >
		// `start`). Artifact components (image, no `dev` override) resolve to
		// undefined — they were warned by the guard; skip them.
		const startCmd = sourceRunCommand(component);
		if (!startCmd) continue;

		pm2.register(name, {
			command: startCmd,
			env: { ...process.env as Record<string, string>, ...allEnvs[name] },
			cwd: join(projectDir, component.source ?? component.build?.context ?? "."),
			dependsOn: component.depends_on,
			health: component.health,
			port: componentPorts[name],
		});
	}

	// Handle Ctrl+C gracefully
	const finalState = state;
	process.on("SIGINT", async () => {
		console.log("\n\nShutting down...");
		await pm2.stopAll();
		// Processes are now dead; clear the recorded pids so a later `launch down`
		// doesn't try to signal stale (and possibly recycled) pids.
		finalState.processes = {};
		await saveState(projectDir, finalState);
		process.exit(0);
	});

	await pm2.startAll();
	console.log("");
	console.log(`  \u2713 All components started`);

	// Record spawned pids so `launch down` can stop them from another shell or
	// after this foreground session ends (closes #49). Backward compatible: the
	// field is optional and absent in pre-existing state files.
	state.processes = pm2.getRecordedProcesses();

	// 17. Print summary
	printSummary(launch, componentPorts, resourceMap);

	// Save final state (now including recorded pids)
	await saveState(projectDir, state);
}

function printSummary(
	launch: NormalizedLaunch,
	ports: Record<string, number>,
	_resources: Record<string, ResourceProperties>,
): void {
	console.log("");
	for (const [name, port] of Object.entries(ports)) {
		const label = name === "default" ? launch.name : name;
		console.log(`  ${label} is running at http://localhost:${port}`);
	}
	console.log("\n  Press Ctrl+C to stop all processes.");
}

export async function launchDown(opts: { destroy?: boolean; projectDir?: string } = {}): Promise<void> {
	const projectDir = opts.projectDir ?? process.cwd();
	const state = await loadState(projectDir);
	if (!state) {
		console.log("No active launch state found.");
		return;
	}

	// Stop recorded app processes (closes #49). Backward compatible: state files
	// written before pid persistence simply have no `processes`, so we skip this
	// and behave exactly as before (resources-only down).
	const recorded = state.processes ?? {};
	if (Object.keys(recorded).length > 0) {
		console.log("Stopping app processes...");
		const outcomes = await stopRecordedProcesses(recorded);
		for (const o of outcomes) {
			switch (o.result) {
				case "stopped":
					console.log(`  Stopped ${o.component}`);
					break;
				case "already-dead":
					console.log(`  ${o.component} was not running`);
					break;
				case "identity-mismatch":
					console.log(`  Skipped ${o.component} (pid recycled — left untouched)`);
					break;
				case "error":
					console.log(`  Failed to stop ${o.component}: ${o.error}`);
					break;
			}
		}
		// Clear recorded pids now that we've handled them.
		state.processes = {};
		if (!opts.destroy) {
			await saveState(projectDir, state);
		}
	}

	if (opts.destroy) {
		console.log("Destroying resources...");
		for (const [name, resourceState] of Object.entries(state.resources)) {
			const provisioner = getProvisioner(resourceState.type);
			if (provisioner) {
				console.log(`  Destroying ${resourceState.type} (${name})...`);
				await provisioner.destroy(resourceState);
			}
		}

		// Clean up state
		const { rm } = await import("node:fs/promises");
		await rm(join(projectDir, ".launchfile"), { recursive: true, force: true });
		console.log("  Cleaned up .launchfile/");
	} else {
		console.log("Stopped. Resources are still running (use --destroy to remove them).");
	}
}

// --detach is intentionally left as a follow-up: persisting pids (this PR) is
// the prerequisite for it. With pids now recorded and a working cross-session
// `down`, detach becomes "spawn detached + unref + don't install the SIGINT
// foreground loop, then return" — a self-contained change best done separately
// so the kill-path fix lands reviewable on its own.

export async function launchStatus(opts: { projectDir?: string } = {}): Promise<void> {
	const projectDir = opts.projectDir ?? process.cwd();
	const state = await loadState(projectDir);
	if (!state) {
		console.log("No active launch state found.");
		return;
	}

	console.log(`App: ${state.appName}`);
	console.log(`Created: ${state.createdAt}`);
	console.log(`Updated: ${state.updatedAt}`);

	if (Object.keys(state.ports).length > 0) {
		console.log("\nComponents:");
		for (const [name, port] of Object.entries(state.ports)) {
			console.log(`  ${name}: http://localhost:${port}`);
		}
	}

	if (Object.keys(state.resources).length > 0) {
		console.log("\nResources:");
		for (const [name, res] of Object.entries(state.resources)) {
			const provisioner = getProvisioner(res.type);
			const running = provisioner ? await provisioner.isRunning() : false;
			console.log(`  ${name} (${res.type}): ${running ? "running" : "stopped"} on port ${res.port}`);
		}
	}
}

export async function launchEnv(opts: { component?: string; projectDir?: string } = {}): Promise<void> {
	const projectDir = opts.projectDir ?? process.cwd();

	const launchfileContent = await readFile(join(projectDir, "Launchfile"), "utf8");
	const launch = readLaunch(launchfileContent);
	const state = await loadState(projectDir);

	if (!state) {
		console.log("No active launch state. Run `launch up` first.");
		return;
	}

	// Rebuild resource map from state
	const resourceMap: Record<string, ResourceProperties> = {};
	for (const [name, res] of Object.entries(state.resources)) {
		const provisioner = getProvisioner(res.type);
		if (provisioner) {
			const result = await provisioner.provision(
				{ type: res.type, name: res.name },
				{ appName: state.appName, projectDir },
				res,
			);
			resourceMap[name] = result.properties;
		}
	}

	const appProperties = computeAppProperties(launch, state.ports);
	const context = buildResolverContext(resourceMap, state.ports, state.secrets, appProperties);

	for (const [name, component] of Object.entries(launch.components)) {
		if (opts.component && name !== opts.component) continue;

		const env = resolveComponentEnv(component, context, resourceMap);
		await resolveGenerators(component, env);

		const port = state.ports[name];
		if (port && !env.PORT) env.PORT = String(port);

		console.log(`\n# ${name}`);
		for (const [key, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
			console.log(`${key}=${value}`);
		}
	}
}
