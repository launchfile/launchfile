/**
 * Main provider orchestration — the `launch up` sequence.
 *
 * Reads a Launchfile, provisions resources, resolves env vars,
 * installs runtimes, and starts all components.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readLaunch, type NormalizedLaunch } from "@launchfile/sdk";
import { checkPrereqs } from "./prereqs.js";
import { loadState, initState, saveState, ensureDirs } from "./state.js";
import {
	buildResolverContext,
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
import { shell } from "./shell.js";

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

	// 8. Build resolver context
	const context = buildResolverContext(resourceMap, componentPorts, state.secrets);

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

	// 14. Run build commands
	if (!opts.noBuild) {
		for (const [name, component] of Object.entries(launch.components)) {
			const buildCmd = component.commands?.build?.command;
			const cmd = buildCmd ?? pm?.installCommand;
			if (cmd) {
				console.log(`  \u2193 Building${componentNames.length > 1 ? ` [${name}]` : ""}...`);
				await shell(cmd, {
					cwd: projectDir,
					env: allEnvs[name],
				});
			}
		}
	}

	// 15. Run release commands (migrations)
	for (const [name, component] of Object.entries(launch.components)) {
		const releaseCmd = component.commands?.release?.command;
		if (releaseCmd) {
			console.log(`  \u2193 Running release${componentNames.length > 1 ? ` [${name}]` : ""}...`);
			await shell(releaseCmd, {
				cwd: projectDir,
				env: allEnvs[name],
			});
		}
	}

	// 16. Start all components
	process.stdout.write(`  \u2193 Starting services...`);
	const pm2 = new ProcessManager(projectDir);

	for (const [name, component] of Object.entries(launch.components)) {
		const startCmd = component.commands?.start?.command;
		if (!startCmd) {
			console.warn(`\n  ! [${name}] No start command — skipping`);
			continue;
		}

		pm2.register(name, {
			command: startCmd,
			env: { ...process.env as Record<string, string>, ...allEnvs[name] },
			cwd: projectDir,
			dependsOn: component.depends_on,
			health: component.health,
			port: componentPorts[name],
		});
	}

	// Handle Ctrl+C gracefully
	process.on("SIGINT", async () => {
		console.log("\n\nShutting down...");
		await pm2.stopAll();
		await saveState(projectDir, state!);
		process.exit(0);
	});

	await pm2.startAll();
	console.log("");
	console.log(`  \u2713 All components started`);

	// 17. Print summary
	printSummary(launch, componentPorts, resourceMap);

	// Save final state
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

	const context = buildResolverContext(resourceMap, state.ports, state.secrets);

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
