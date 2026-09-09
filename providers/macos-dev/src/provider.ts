/**
 * Main provider orchestration — the `launch up` sequence.
 *
 * Reads a Launchfile, provisions resources, resolves env vars,
 * installs runtimes, and starts all components.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import {
	indexOperatorStoragePaths,
	MissingOperatorStoragePathError,
	readLaunch,
	resolveSourcePrepareCommand,
	resolveSourceRunCommand,
	selectionClosure,
	type StorageBind,
	UnboundOperatorStorageError,
	type UnboundOperatorVolume,
	unsuppliedRequiredEnv,
	type NormalizedLaunch,
	type NormalizedComponent,
} from "@launchfile/sdk";

import { checkPrereqs } from "./prereqs.js";
import { loadState, initState, saveState, ensureDirs } from "./state.js";
import {
	buildResolverContext,
	computeAppProperties,
	resolveComponentEnv,
	generateSecrets,
	resolveGenerators,
	writeEnvFile,
	type UnsuppliedRequiredEnv,
} from "./env-writer.js";
import { getProvisioner, type ResourceProperties } from "./resources/index.js";
import { allocatePorts } from "./port-allocator.js";
import { getRuntimeInstaller } from "./runtimes/index.js";
import { detectPackageManager } from "./lockfile-detect.js";
import { provisionStorage, storagePaths } from "./storage.js";
import { ProcessManager } from "./process-manager.js";
import { stopRecordedProcesses } from "./process-stopper.js";
import { shellScript } from "./shell.js";
import { parseDuration } from "./bootstrap.js";

/**
 * This provider runs apps from source. A component is source-runnable when
 * {@link resolveSourceRunCommand} (D-38) resolves a command — declares `dev`,
 * or a `start` with no `image`. An `image` without a `dev` override stays
 * artifact-mode, which this source-only provider can't launch.
 */
export function isSourceRunnable(component: NormalizedComponent): boolean {
	return resolveSourceRunCommand(component) !== undefined;
}

/**
 * Parse a declared timeout, adding the stage/component label to the error.
 * An unparseable duration is surfaced — it fails the stage that declared it
 * (PROVIDERS.md §10.10) — never silently replaced with a default. Undefined
 * passes through so callers keep their own default budgets.
 */
function declaredTimeout(timeout: string | undefined, label: string): number | undefined {
	if (timeout === undefined) return undefined;
	try {
		return parseDuration(timeout);
	} catch (err) {
		throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export interface LaunchUpOpts {
	withOptional?: boolean;
	noBuild?: boolean;
	detach?: boolean;
	dryRun?: boolean;
	projectDir?: string;
	/**
	 * Component selector (#77): if non-empty, these components plus their
	 * transitive downward `depends_on` closure are started (D-41), and the
	 * `requires` of every closure member are provisioned. The start-set is the
	 * SDK's `selectionClosure` — the same definition the Docker provider uses —
	 * so both yield the identical running topology (P-5). Empty = all components.
	 */
	components?: string[];
	/**
	 * Host paths for `content: operator` volumes (D-50 rule 1), keyed as the
	 * operator typed them: `<volume>`, or `<component>.<volume>` where a volume
	 * name is ambiguous. Relative paths resolve against the current directory.
	 */
	storage?: Record<string, string>;
}

/** Whether a path exists and this process can read it (D-50 rule 2, row 3). */
function isReadable(path: string): boolean {
	try {
		accessSync(path, fsConstants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Components this provider must refuse, mapped to the capabilities it cannot
 * grant (D-44, PROVIDERS.md §11). Both spellings fold together so the `host:`
 * entry form and the legacy top-level block produce the same outcome.
 *
 * A refusal must remove the component from the run, not merely report it —
 * this provider grants no host capabilities, so anything listed here cannot
 * be installed, wired, registered, or started.
 */
export function refusedHostCapabilities(
	launch: NormalizedLaunch,
): Map<string, string[]> {
	const refused = new Map<string, string[]>();
	for (const [name, c] of Object.entries(launch.components)) {
		const caps: string[] = [];
		for (const req of c.requires ?? []) {
			for (const [capability, value] of Object.entries(req.host ?? {})) {
				caps.push(`${capability}=${String(value)}`);
			}
		}
		if (c.host?.docker === "required")
			caps.push("container_runtime=docker (host.docker)");
		if (c.host?.network === "host") caps.push("network=host (host.network)");
		if (c.host?.privileged) caps.push("privileged=true (host.privileged)");
		if (caps.length > 0) refused.set(name, caps);
	}
	return refused;
}

/**
 * The launch-time notice a provider without a scheduler owes for a declared
 * `schedule` (D-51, PROVIDERS.md §10 item 8).
 *
 * States what *this provider* does, not what will happen to the app: a
 * component may schedule itself — `catalog/drafts/diun` sets its own
 * `DIUN_WATCH_SCHEDULE`, and nextcloud's `cron.sh` is a foreground `crond` —
 * so claiming the job will not run would be false about those apps, and a
 * warning that misstates the user's app is worse than the silence it replaces.
 */
export function scheduleWarning(component: string, schedule: string): string {
	return (
		`[${component}] declares \`schedule: ${schedule}\` — this provider will not ` +
		"run it on a timer. If the component does not schedule itself, the job will not run."
	);
}

/**
 * Remove every component this provider must refuse, and say so on stderr.
 *
 * The removal is the refusal (D-44, PROVIDERS.md §11): a component left in the
 * map goes on to be installed, env-wired, registered with the process manager
 * and started, so logging alone would have the provider assert a refusal it
 * did not perform. Mutates `launch.components` for exactly that reason —
 * everything downstream reads it.
 *
 * Returns "none-left" when nothing survives, so the caller can fail rather than
 * report success over an empty set.
 */
export function applyHostCapabilityRefusals(
	launch: NormalizedLaunch,
): "ok" | "none-left" {
	const refused = refusedHostCapabilities(launch);
	for (const [name, caps] of refused) {
		console.error(
			`  Refused: ${name} requires host capabilities this provider cannot grant ` +
				`(${caps.join("; ")}) — component not started`,
		);
	}
	if (refused.size === 0) return "ok";
	launch.components = Object.fromEntries(
		Object.entries(launch.components).filter(([n]) => !refused.has(n)),
	);
	return Object.keys(launch.components).length === 0 ? "none-left" : "ok";
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
	const allComponentNames = Object.keys(launch.components);

	// Resolve component selector (#77) into its D-41 start-set: selected
	// components + their transitive downward `depends_on` closure (and, by
	// narrowing to that set, every closure member's `requires`). Narrowing
	// launch.components here makes every downstream phase loop in launchUp honor
	// the closure without per-loop edits — dropping it would hand back an app
	// missing the very dependencies a selected component needs to start (D-16).
	// down/status/env re-read the file, so they are unaffected.
	const selection = selectionClosure(launch, opts.components ?? []);
	if (selection.unknown.length > 0 || selection.resources.length > 0) {
		console.error(`\nCannot select: ${[...selection.unknown, ...selection.resources].join(", ")}`);
		for (const r of selection.resources) {
			console.error(`  - "${r}" is a backing resource, not a component; select the component that requires it.`);
		}
		for (const u of selection.unknown) {
			console.error(`  - "${u}" matches no component. Available: ${allComponentNames.join(", ")}`);
		}
		process.exit(1);
	}
	if (opts.components && opts.components.length > 0) {
		const startSet = new Set(selection.start);
		launch.components = Object.fromEntries(
			Object.entries(launch.components).filter(([n]) => startSet.has(n)),
		);
	}
	// 2a. Host capabilities are granted or refused, never provisioned (D-44,
	// PROVIDERS.md §11). This provider runs processes directly on the host and
	// grants none of them, so a component with a required capability is
	// DECLINED — removed from the map here so nothing downstream installs a
	// runtime, wires env, registers with pm2, or starts it. Logging alone would
	// leave the provider asserting a refusal it did not perform.
	// Both spellings fold together so they land identically (§11 equivalence):
	// the `host:` entry form and the legacy top-level block.
	if (applyHostCapabilityRefusals(launch) === "none-left") {
		console.error(
			"Every selected component requires a host capability this provider cannot grant.",
		);
		process.exit(1);
	}
	// An optional capability is not refused — the component runs, degraded.
	for (const [name, c] of Object.entries(launch.components)) {
		for (const sup of c.supports ?? []) {
			for (const [capability, value] of Object.entries(sup.host ?? {})) {
				console.warn(
					`  Warning: ${name}: optional host capability ` +
						`${capability}=${String(value)} not granted — running degraded`,
				);
			}
		}
	}

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

		// PROVIDERS.md conformance rule 8 (D-51): a provider that does not
		// execute `schedule` MUST say so at launch. Staying silent leaves an
		// author believing a declared cron job is running — the one outcome
		// worse than not supporting it. Wording stays start-agnostic: artifact
		// components with a schedule reach this loop too, and they are skipped
		// entirely in source mode.
		if (c.schedule) {
			console.warn(`  ! ${scheduleWarning(name, c.schedule)}`);
		}
	}

	// 2c. Unsupplied `required:` environment variables (D-52, PROVIDERS.md §10
	// rule 8, deploying branch). This provider's operator channel is the
	// launching environment, read EXPLICITLY here — the `...process.env` spread
	// on the pm2 registration below is incidental inheritance that never reaches
	// `release` and is invisible to `env`, so it cannot serve as the channel.
	// Values found are carried in `operatorEnv` and merged into `allEnvs` at
	// step 12, which puts them on both `release` and `start` and makes them
	// visible to `launch env`. Anything still missing fails HERE — before
	// directories, resources, ports, runtimes, or processes exist. No prompt: a
	// non-interactive invocation must fail by name, not hang on stdin.
	const operatorEnv: Record<string, Record<string, string>> = {};
	const missingRequired: { component: string; key: string; sensitive: boolean }[] = [];
	for (const [name, component] of Object.entries(launch.components)) {
		// A `requires:` binding injects only when this provider can provision the
		// resource behind it; `supports:` is provisioned only under --with-optional
		// and is never credited (SPEC.md §Supports).
		const arriving = new Set(
			(component.requires ?? [])
				.filter((req) => !req.host && getProvisioner(req.type))
				.flatMap((req) => Object.keys(req.set_env ?? {})),
		);
		for (const { key, sensitive } of unsuppliedRequiredEnv(component, arriving)) {
			const supplied = process.env[key];
			if (supplied !== undefined) {
				(operatorEnv[name] ??= {})[key] = supplied;
				continue;
			}
			missingRequired.push({ component: name, key, sensitive });
		}
	}
	if (missingRequired.length > 0) {
		console.error(
			`\nCannot launch: ${missingRequired.length} required environment variable${missingRequired.length === 1 ? "" : "s"} had no value.`,
		);
		for (const { component, key, sensitive } of missingRequired) {
			console.error(`  - ${component}: ${key}${sensitive ? " (sensitive)" : ""}`);
		}
		console.error(
			"\nThe Launchfile declares them `required:` with no `default:`, `generator:`, or resource",
		);
		console.error("binding, so you supply them. Set them in the environment and run `up` again, e.g.");
		console.error(`  ${missingRequired[0]!.key}=<value> launch up`);
		process.exit(1);
	}

	// 2d. Operator-supplied storage (D-50 rules 1–2), settled here — before
	// state, directories, resources, ports, runtimes or processes exist, and so
	// before `--dry-run` returns. A marked volume with no path, or with one that
	// is not on disk, fails the launch: an empty directory where the operator's
	// library belongs is D-52's fabrication in storage form, and this provider
	// creates neither.
	//
	// Scoped to the components this provider will actually run. An artifact
	// component is warned about and skipped at step 16, so refusing the whole
	// launch over storage it will never read would be a refusal about nothing —
	// the same reason `@launchfile/docker` only examines components it
	// translates. Its volumes simply stay unprovisioned at step 11.
	//
	// Unlike the host-capability refusal above, this throws rather than dropping
	// the component: `@launchfile/docker` fails the whole launch for the same
	// file, and one Launchfile must not yield two topologies (P-5).
	const suppliedStorage = opts.storage
		? Object.fromEntries(
				Object.entries(opts.storage).map(([key, path]) => [key, resolvePath(path)]),
			)
		: undefined;
	const storageIndex = indexOperatorStoragePaths(launch, suppliedStorage);
	const usedStorageKeys = new Set<string>();
	const unboundVolumes: UnboundOperatorVolume[] = [];
	const storageBinds: StorageBind[] = [];
	const operatorStorage: Record<string, Record<string, string>> = {};
	for (const [name, component] of Object.entries(launch.components)) {
		if (!isSourceRunnable(component)) continue;
		for (const [volName, vol] of Object.entries(component.storage ?? {})) {
			if (vol.content !== "operator") continue;
			const supplied = storageIndex.lookup(name, volName);
			if (!supplied) {
				unboundVolumes.push({
					component: name,
					volume: volName,
					flag: storageIndex.flagFor(name, volName),
				});
				continue;
			}
			usedStorageKeys.add(supplied.key);
			storageBinds.push({
				component: name,
				volume: volName,
				key: supplied.key,
				hostPath: supplied.path,
				containerPath: vol.path,
			});
			(operatorStorage[name] ??= {})[volName] = supplied.path;
		}
	}
	if (unboundVolumes.length > 0) {
		throw new UnboundOperatorStorageError(unboundVolumes);
	}
	const unreadableBinds = storageBinds.filter((bind) => !isReadable(bind.hostPath));
	if (unreadableBinds.length > 0) {
		throw new MissingOperatorStoragePathError(unreadableBinds);
	}
	// A supplied key that bound nothing would otherwise vanish without a trace,
	// so a typo'd name surfaces here. Row 4 keeps unmarked volumes untouched, so
	// a key naming one is unused too.
	for (const key of storageIndex.unusedKeys(usedStorageKeys)) {
		console.warn(`  Warning: --storage ${key} matches no \`content: operator\` volume — ignored`);
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
			if (req.host) continue; // capability, not a backing service (D-44)
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
				if (sup.host) continue; // capability, not a backing service (D-44)
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

	// 11. Create storage directories, capturing each volume's resolved local path
	// so it can be injected as $storage.<name>.path (D-39). Scoped per component.
	const componentStorage: Record<string, Record<string, Record<string, string>>> = {};
	for (const [name, component] of Object.entries(launch.components)) {
		const volumeMap = await provisionStorage(
			component.storage,
			name,
			projectDir,
			operatorStorage[name],
		);
		const storageCtx: Record<string, Record<string, string>> = {};
		for (const [volName, localPath] of Object.entries(volumeMap)) {
			storageCtx[volName] = { path: localPath };
		}
		componentStorage[name] = storageCtx;
	}

	// 12. Resolve env vars and write .env files
	const allEnvs: Record<string, Record<string, string>> = {};
	const isSingleComponent = componentNames.length === 1 && componentNames[0] === "default";

	// Minted env-level generator values live in state (D-49) so a redeploy
	// reuses them; saveState below (step 13) persists anything minted here.
	const generatedEnv = (state.generatedEnv ??= {});

	for (const [name, component] of Object.entries(launch.components)) {
		const { env } = resolveComponentEnv(component, context, resourceMap, componentStorage[name]);
		await resolveGenerators(component, env, name, generatedEnv);

		// Operator-supplied `required:` values (step 2c) join the resolved set, so
		// they reach `release` and `start` alike and show up in `launch env`.
		Object.assign(env, operatorEnv[name] ?? {});

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
	// The bound operator paths ride along so `env` can report the directory the
	// app actually reads (D-50); a later `up` still has to supply them again.
	state.operatorStorage = operatorStorage;
	await saveState(projectDir, state);

	if (opts.dryRun) {
		console.log("\n[dry-run] Would now run build, release, and start commands.");
		printSummary(launch, componentPorts, resourceMap);
		return;
	}

	// 14. Run source-mode prepare \u2014 `install ?? build` (D-38), on demand
	if (!opts.noBuild) {
		for (const [name, component] of Object.entries(launch.components)) {
			const prepare = resolveSourcePrepareCommand(component);
			const cmd = prepare?.command ?? pm?.installCommand;
			if (cmd) {
				console.log(`  \u2193 Preparing${componentNames.length > 1 ? ` [${name}]` : ""}...`);
				await shellScript(cmd, {
					cwd: join(projectDir, component.source ?? component.build?.context ?? "."),
					env: allEnvs[name],
					// Installs/compiles routinely exceed the 2-minute shell default;
					// honor a declared timeout, else allow 10 minutes.
					timeout: declaredTimeout(prepare?.timeout, `prepare [${name}]`) ?? 600_000,
				});
			}
		}
	}

	// 15. Run release commands (migrations) \u2014 mode-invariant (D-38)
	for (const [name, component] of Object.entries(launch.components)) {
		const release = component.commands?.release;
		if (release?.command) {
			console.log(`  \u2193 Running release${componentNames.length > 1 ? ` [${name}]` : ""}...`);
			await shellScript(release.command, {
				cwd: join(projectDir, component.source ?? component.build?.context ?? "."),
				env: allEnvs[name],
				timeout: declaredTimeout(release.timeout, `release [${name}]`),
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
		const startCmd = resolveSourceRunCommand(component)?.command;
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

	// `env` reports what the running app has, so it reads minted generator
	// values from the same store `up` persists to (D-49). A value can still be
	// minted here — a generator declared after the last `up` — and then it is
	// persisted below, before printing, so `up`, `env`, and `bootstrap` all
	// keep answering with the same value.
	const generatedEnv = (state.generatedEnv ??= {});
	let minted = false;
	const resolvedEnvs: [string, Record<string, string>, UnsuppliedRequiredEnv[]][] = [];

	for (const [name, component] of Object.entries(launch.components)) {
		if (opts.component && name !== opts.component) continue;

		// Resolved storage paths (D-39) — computed, not provisioned (no mkdir):
		// `launchfile env` only prints, and the dirs already exist from `up`.
		// A `content: operator` volume reads back the host path `up` bound
		// (D-50), so what prints here is what the running app was given.
		const storageCtx: Record<string, Record<string, string>> = {};
		for (const [volName, localPath] of Object.entries(
			storagePaths(component.storage, name, projectDir, state.operatorStorage?.[name]),
		)) {
			storageCtx[volName] = { path: localPath };
		}

		const { env, unsupplied } = resolveComponentEnv(component, context, resourceMap, storageCtx);
		minted = (await resolveGenerators(component, env, name, generatedEnv)) || minted;

		// The operator channel `up` reads (the launching environment) answers here
		// too, so a var supplied at launch time prints as a real value rather than
		// being reported missing.
		for (const { key } of unsupplied) {
			const supplied = process.env[key];
			if (supplied !== undefined) env[key] = supplied;
		}

		const port = state.ports[name];
		if (port && !env.PORT) env.PORT = String(port);

		resolvedEnvs.push([name, env, unsupplied]);
	}

	if (minted) {
		await saveState(projectDir, state);
	}

	for (const [name, env, unsupplied] of resolvedEnvs) {
		console.log(`\n# ${name}`);
		for (const [key, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
			console.log(`${key}=${value}`);
		}
		// PROVIDERS.md §10 rule 8, `env` branch: report an unsupplied required var
		// rather than dropping it — this is where an operator comes to find out
		// what is missing. It goes out as a `#` comment, never a bare `KEY=` line,
		// because this output is designed to be `eval`'d (§2): a bare line would
		// export an empty value and re-create the failure the rule exists to stop.
		for (const { key, sensitive } of unsupplied.sort((a, b) => a.key.localeCompare(b.key))) {
			if (env[key] !== undefined) continue;
			console.log(
				`# ${key}: unsupplied — required, no default/generator/binding` +
					`${sensitive ? ", sensitive" : ""}. Supply it in the environment.`,
			);
		}
	}
}
