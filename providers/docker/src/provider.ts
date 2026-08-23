/**
 * Main provider orchestration — docker compose lifecycle management.
 */

import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { readLaunch, selectionClosure } from "@launchfile/sdk";
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
	type StateEndpoint,
} from "./state.js";
import { allocatePorts } from "./port-allocator.js";
import { launchToCompose, type UnsuppliedRequiredVar } from "./compose-generator.js";
import { planReleases, runReleases } from "./release.js";
import { shell, shellStream } from "./shell.js";
import { getLogger, withSpan } from "./logger.js";
import {
	captureComposeLogs,
	declaredEnvKeys,
	dockerErrorKey,
	dockerLaunchError,
	inPhase,
	type PhaseContext,
} from "./errors.js";
import { readdir } from "node:fs/promises";

export interface DockerUpOpts {
	detach?: boolean;
	dryRun?: boolean;
	/** Skip confirmation prompt for remote Launchfiles */
	yes?: boolean;
	/**
	 * Component selector (#77): if non-empty, these components plus their
	 * transitive downward `depends_on` closure are started (D-41). The start-set
	 * is computed from the SDK's `selectionClosure` — the same definition the
	 * macOS provider uses — so both produce the identical running topology (P-5),
	 * rather than leaning on compose's implicit `depends_on` expansion. Each
	 * closure member's `requires` come along via compose `depends_on`. Empty =
	 * all components.
	 */
	components?: string[];
}

/**
 * A deploy refused because a `required:` variable arrived from neither the
 * Launchfile nor the operator (D-52, PROVIDERS.md §10 rule 8, deploying branch).
 *
 * The message names every offending component and variable in one go, and never
 * prints a value — for a `sensitive: true` var it would be a credential, and for
 * the rest it would be noise the operator already knows.
 */
export class UnsuppliedRequiredEnvError extends Error {
	/** An operator-fixable precondition, not a crash — see `ExpectedRefusal`. */
	readonly expectedRefusal = true as const;
	readonly vars: UnsuppliedRequiredVar[];

	constructor(vars: UnsuppliedRequiredVar[]) {
		const lines = vars.map(
			({ component, key, sensitive }) =>
				`  - ${component}: ${key}${sensitive ? " (sensitive)" : ""}`,
		);
		super(
			`Cannot launch: ${vars.length} required environment variable${vars.length === 1 ? "" : "s"} ` +
				"had no value.\n" +
				`${lines.join("\n")}\n` +
				"The Launchfile declares them `required:` with no `default:`, `generator:`, or resource\n" +
				"binding, so you supply them. Set them in the environment and run `up` again, e.g.\n" +
				`  ${vars[0]!.key}=<value> launchfile up`,
		);
		this.name = "UnsuppliedRequiredEnvError";
		this.vars = vars;
	}
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
	// Every throw below is tagged with the phase it happened in, at the throw
	// site where the phase is known, and carries an already-redacted context the
	// CLI persists for `launchfile diagnose` (#44). Phases are the D-48 slot
	// names plus the pre-slot failure points, never command names.
	const sourceContext: PhaseContext = { key: dockerErrorKey({ source }) };

	// Resolve source before the span so we have the slug for span context
	const resolved = await inPhase("resolve", sourceContext, () => resolveSource(source));

	const key = dockerErrorKey({ slug: resolved.slug });

	// Anything that escapes without a phase still gets a record, tagged
	// `unknown` rather than guessed at — an untagged failure would leave
	// `diagnose` with nothing to show for a run that visibly failed.
	return inPhase("unknown", { key, slug: resolved.slug }, () =>
	withSpan("up", { source, slug: resolved.slug }, async () => {
		const log = getLogger();

		// Check prerequisites
		if (!opts.dryRun) {
			const prereqs = await checkPrereqs();
			if (!prereqs.ok) {
				console.error("\nMissing prerequisites:");
				for (const m of prereqs.missing) console.error(`  - ${m}`);
				throw dockerLaunchError({
					phase: "prereq",
					key,
					slug: resolved.slug,
					message: `Missing prerequisites: ${prereqs.missing.join("; ")}`,
				});
			}
		}

		// Parse Launchfile
		const launch = await inPhase("parse", { key, slug: resolved.slug }, async () =>
			readLaunch(resolved.yaml),
		);
		const componentNames = Object.keys(launch.components);

		// Identity + declared env names, shared by every phase context below.
		// `declaredEnvKeys` reads names from the Launchfile — no resolved value is
		// ever in scope here, so none can reach a record.
		const failure = (extra: Partial<PhaseContext> = {}): PhaseContext => ({
			key,
			slug: resolved.slug,
			app: launch.name,
			env: declaredEnvKeys(launch),
			...extra,
		});

		// Resolve component selector (#77) into its D-41 start-set: selected
		// components + their transitive downward `depends_on` closure. Empty = all.
		const selection = selectionClosure(launch, opts.components ?? []);
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
		const selectorActive = (opts.components?.length ?? 0) > 0;
		// Pass the explicit closure to `compose up` rather than relying on compose's
		// implicit depends_on expansion, so the start-set matches macOS exactly.
		const selectedServices = selectorActive
			? selection.start.map((name) => serviceNameFor(launch.name, name))
			: [];
		// When a selector is active, the post-up summary reports only the components
		// actually started this invocation (#77) — now the full closure, not just
		// the directly-named ones. Undefined means "report all".
		const summaryOnly = selectorActive ? new Set(selection.start) : undefined;

		// Security: prompt for confirmation before executing remote Launchfiles.
		// Remote content can specify arbitrary images, commands, and env vars.
		if (resolved.source !== "local" && !opts.yes && !opts.dryRun) {
			const resources = componentNames.flatMap((name) => {
				const comp = launch.components[name];
				// Host-capability entries (D-44) are not backing resources
				return (comp?.requires ?? []).filter((r) => !r.host).map((r) => r.type);
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

		// Allocate host ports
		const hostPorts = await inPhase("provision", failure(), () =>
			allocatePorts(launch.components, launch.name, state.ports),
		);

		// Generate compose. `process.env` is this provider's operator channel for
		// `required:` variables the Launchfile supplies no value for (PROVIDERS.md
		// §10 rule 8) — `URL=https://wiki.example.com launchfile up` supplies one.
		const result = await inPhase("provision", failure(), async () =>
			launchToCompose(launch, {
				secrets: state.secrets,
				generatedEnv: state.generatedEnv,
				hostPorts,
				projectDir: resolved.dir,
				operatorEnv: process.env,
			}),
		);

		// Fail on whatever the operator channel did not cover — before the compose
		// file is written and before any image, network, or container exists
		// (D-52; a fail branch that leaves half a stack up is worse than the
		// fabrication it replaces). Bounded by what is actually being launched:
		// a component outside the start-set, or one this provider skipped, is not
		// a launch-blocking gap (§5 rule 4). No prompt — a non-interactive
		// invocation must fail by name rather than hang on stdin. No values are
		// printed, sensitive or not.
		const launching = new Set(
			Object.keys(result.services).filter((name) => !selectorActive || selection.start.includes(name)),
		);
		const blocking = result.unsuppliedRequired.filter((v) => launching.has(v.component));
		if (blocking.length > 0) {
			throw new UnsuppliedRequiredEnvError(blocking);
		}

		// Past the refusal gate — from here the provider starts leaving things on
		// disk, so the state directory is created here rather than earlier.
		await ensureStateDir(resolved.slug);

		// Log warnings; refusals (un-grantable host capabilities, D-44) are
		// surfaced distinctly — a refusal is user-visible output, not a line
		// buried in a warnings list (PROVIDERS.md §11).
		for (const w of result.warnings) {
			log.warn({ warning: w }, "compose generation warning");
			if (w.startsWith("refused:")) {
				console.error(`  Refused: ${w.slice("refused: ".length)}`);
			} else {
				console.warn(`  Warning: ${w}`);
			}
		}

		// Update state. The full ports map (composite keys included) is what
		// the allocator reads back on the next `up` — persisting only the
		// primary would let every secondary endpoint move across restarts.
		state.secrets = result.secrets;
		state.generatedEnv = result.generatedEnv;
		state.ports = result.ports;
		state.endpoints = result.endpoints;

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
			printSummary(launch.name, result.ports, summaryOnly, result.endpoints);
			return upResult;
		}

		// Carry what the launch reported (compose warnings, including the D-51
		// unexecuted-`schedule` note) alongside whatever kills it.
		const warnings = result.warnings;

		// Write compose file
		await inPhase("provision", failure({ warnings }), () =>
			withSpan("up:compose", { slug: resolved.slug }, async () => {
				// Security: compose file contains passwords in environment variables
				const file = composePath(resolved.slug);
				await writeFile(file, result.yaml, { mode: 0o600 });
			}),
		);

		// Save state
		await inPhase("provision", failure({ warnings }), () =>
			saveState(resolved.slug, state),
		);

		const project = composeProject(resolved.slug);
		const composeFile = composePath(resolved.slug);
		const withLogs = (extra: Partial<PhaseContext> = {}): PhaseContext =>
			failure({ warnings, logs: () => captureComposeLogs(project, composeFile), ...extra });

		// Pull images for services that don't build from source
		if (result.images.length > 0) {
			await inPhase("prepare", failure({ warnings }), () =>
			withSpan("up:pull", { images: result.images }, async () => {
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
			}),
			);
		}

		// Build images for services with a build: config. Source builds run
		// inside docker build — nothing from the repo executes on the host.
		if (result.builds.length > 0) {
			await inPhase("prepare", failure({ warnings }), () =>
			withSpan("up:build", { services: result.builds }, async () => {
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
			}),
			);
		}

		// Configure resources (if any)
		const resources = componentNames.flatMap((name) => {
			const comp = launch.components[name];
			// Host-capability entries (D-44) are refused/noted, not configured
			return (comp?.requires ?? []).filter((r) => !r.host).map((r) => r.type);
		});
		for (const res of resources) {
			console.log(`  \u2193 Configuring ${res}... done`);
		}

		// Wire env vars (if any resources)
		if (resources.length > 0) {
			console.log(`  \u2193 Wiring environment variables... done`);
		}

		// Run declared release commands as one-shot containers before any app
		// service starts (SPEC.md § Failure semantics: resources ready →
		// release → start). `compose run --rm` brings each component's
		// `depends_on` up first (backing resources gate on service_healthy);
		// a non-zero exit throws and aborts the deploy here.
		const releasePlan = planReleases(launch, {
			services: result.services,
			hostPorts: result.ports,
			secrets: state.secrets,
			only: summaryOnly,
		});
		if (releasePlan.length > 0) {
			// D-48: a release failure fails the DEPLOY — a different disposition
			// from the prepare and run slots either side of it.
			await inPhase("release", withLogs(), () =>
				withSpan(
					"up:release",
					{ project, components: releasePlan.map((r) => r.component) },
					async () => {
						await runReleases(releasePlan, { project, composeFile });
					},
				),
			);
		}

		// Start services
		await inPhase("run", withLogs(), () =>
			withSpan("up:start", { project }, async () => {
			process.stdout.write(`  \u2193 Starting services...`);
			// The closure's services start with their compose `depends_on` (resources)
			// pulled in automatically; components outside the closure stay down (#77).
			await shell(
				"docker",
				["compose", "-p", project, "-f", composeFile, "up", "-d", ...selectedServices],
				{ silent: true },
			);
			console.log("");
			}),
		);

		// Wait for health. SPEC.md § Failure semantics: a component that
		// never becomes healthy FAILS THE INVOCATION. A health check is not a
		// command slot, but D-48 gives it a disposition, and reporting the timeout
		// as a warning while returning success contradicts it. Containers are left
		// running so the user can inspect what never came up.
		await inPhase("health", withLogs(), () =>
			withSpan("up:health", { project }, async () => {
				const healthy = await waitForHealth(project, composeFile);
				if (!healthy) {
					log.warn(
						{ project },
						"health check timed out — some services never became healthy",
					);
					console.error("  ! Containers are up but never became healthy.");
					console.error("    Inspect them with: launchfile status / launchfile logs");
					throw new Error(
						`no component became healthy within ${HEALTH_TIMEOUT_MS / 1000}s`,
					);
				}
				console.log(`  ✓ Health check passed`);
			}),
		);

		// Print summary
		printSummary(launch.name, result.ports, summaryOnly, result.endpoints);

		return upResult;
	}),
	);
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
			for (const [key, port] of Object.entries(state.ports)) {
				console.log(`  ${key}: ${endpointAddress(port, state.endpoints?.[key]?.protocol)}`);
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

/**
 * How long `up` waits for every container to report healthy before it fails the
 * invocation. A provider-side budget: D-48 binds the *disposition* of the
 * failure, not the number of seconds (P-11).
 */
export const HEALTH_TIMEOUT_MS = 120_000;

async function waitForHealth(project: string, composeFile: string): Promise<boolean> {
	const log = getLogger();
	const maxWait = HEALTH_TIMEOUT_MS;
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

/** The component a ports-map key belongs to (`caddy:https` → `caddy`). */
export function componentOfPortKey(
	key: string,
	endpoints?: Record<string, StateEndpoint>,
): string {
	return endpoints?.[key]?.component ?? key.split(":")[0]!;
}

/**
 * Human-readable address for a published endpoint. HTTP-family protocols get
 * a browsable URL; raw tcp/udp/grpc endpoints get `localhost:<port> (<proto>)`
 * because an `http://` link to an SMTP or DNS port would be wrong. Keys with
 * no endpoint metadata (state files written by older versions) keep the
 * legacy `http://` form.
 */
export function endpointAddress(port: number, protocol?: string): string {
	switch (protocol) {
		case "https":
			return `https://localhost:${port}`;
		case "ws":
			return `ws://localhost:${port}`;
		case "tcp":
		case "udp":
		case "grpc":
			return `localhost:${port} (${protocol})`;
		default:
			return `http://localhost:${port}`;
	}
}

/**
 * Build the "<component> is running at …" summary lines, one per published
 * endpoint.
 *
 * `only`, when provided, restricts the summary to that set of component names —
 * used by the component selector (#77) so a partial `up` doesn't claim that
 * components it never started are running. Composite keys (`caddy:https`)
 * match through their component (`caddy`), so a selected component reports
 * every endpoint it publishes. An undefined `only` means "report everything"
 * (the all-components default). Pure and side-effect-free so it can be
 * unit-tested without spinning Docker.
 */
export function summaryLines(
	appName: string,
	ports: Record<string, number>,
	only?: ReadonlySet<string>,
	endpoints?: Record<string, StateEndpoint>,
): string[] {
	const lines: string[] = [];
	for (const [key, port] of Object.entries(ports)) {
		const component = componentOfPortKey(key, endpoints);
		if (only && !only.has(component)) continue;
		const base = component === "default" ? appName : component;
		// Secondary endpoints carry their endpoint name (D-6) or container
		// port as a qualifier so multi-endpoint components stay tellable apart.
		const qualifier = key === component ? "" : ` (${endpoints?.[key]?.name ?? key.slice(component.length + 1)})`;
		lines.push(`  ${base}${qualifier} is running at ${endpointAddress(port, endpoints?.[key]?.protocol)}`);
	}
	return lines;
}

function printSummary(
	appName: string,
	ports: Record<string, number>,
	only?: ReadonlySet<string>,
	endpoints?: Record<string, StateEndpoint>,
): void {
	console.log("");
	for (const line of summaryLines(appName, ports, only, endpoints)) {
		console.log(line);
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
