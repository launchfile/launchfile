/**
 * Bootstrap command execution for the macOS Dev provider.
 *
 * Implements the `commands.bootstrap` lifecycle stage introduced by D-34:
 * user-invoked, runs after `start` against the running component, captures
 * stdout via regex patterns, re-runnable, and reports failures rather than
 * deploy-failing. Spec: /spec/SPEC.md § Bootstrap stage.
 *
 * The command runs through a POSIX shell (SPEC.md § Command interpretation,
 * PROVIDERS.md §10 item 11), so `&&`, `;`, pipes, redirection, grouping and
 * variable expansion behave as authors write them. It is passed as a single
 * argv element to `/bin/sh -c` via spawn({ shell: false }) — it is never
 * interpolated into a command string on this side, so the only interpreter
 * that sees it is the `sh` this provider spawns.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
	parseDurationMs,
	readLaunch,
	resolveExpression,
	type CaptureEntry,
	type NormalizedLaunch,
	type ResolverContext,
} from "@launchfile/sdk";
import { loadState, saveState } from "./state.js";
import {
	buildResolverContext,
	computeAppProperties,
	resolveComponentEnv,
	resolveGenerators,
} from "./env-writer.js";
import { redactSecrets } from "./redact.js";
import { getProvisioner, type ResourceProperties } from "./resources/index.js";

/** Default budget for a bootstrap command when no `timeout` is declared. */
export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 120_000;

/**
 * The interpreter every bootstrap command runs under. `/bin/sh` is the POSIX
 * shell guaranteed present on macOS.
 */
export const BOOTSTRAP_SHELL = "/bin/sh";

/**
 * Result of running one bootstrap command. Captures may be empty even on
 * success (the command may not produce matching output), and may be
 * partially populated even on failure (some patterns matched before
 * the command errored out).
 */
export interface BootstrapResult {
	component: string;
	command: string;
	ok: boolean;
	exitCode: number;
	captures: Record<string, string>;
	/** Per-capture metadata (description, sensitive) for display. */
	captureMeta: Record<string, CaptureEntry>;
	stdout: string;
	stderr: string;
}

/**
 * Strip ANSI escape sequences from captured stdout before regex matching.
 * CLI tools that detect a TTY will emit color codes that would otherwise
 * break simple patterns like `https?://\S+`.
 */
function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI match
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "");
}

/**
 * Apply a set of capture patterns to a command's stdout. If a pattern has
 * a capture group, the first group is used; otherwise the full match is
 * used. Invalid regexes are skipped (schema validation catches them earlier).
 *
 * Exported for unit testing.
 */
export function extractCaptures(
	stdout: string,
	captures: Record<string, CaptureEntry>,
): Record<string, string> {
	const result: Record<string, string> = {};
	const clean = stripAnsi(stdout);
	for (const [name, def] of Object.entries(captures)) {
		try {
			const match = clean.match(new RegExp(def.pattern));
			if (match) {
				result[name] = (match[1] ?? match[0] ?? "").trim();
			}
		} catch {
			// Invalid regex — skip. CaptureEntrySchema validation catches this.
		}
	}
	return result;
}

/**
 * Parse a simple duration string like "5m", "30s", "1h" into milliseconds
 * using the ratified grammar (D-48). Throws on an unparseable value —
 * PROVIDERS.md §10.10 forbids silently substituting a default. Re-exported
 * for unit testing.
 */
export const parseDuration = parseDurationMs;

/** One planned bootstrap execution, in component declaration order. */
export interface BootstrapPlanItem {
	component: string;
	/** The $-resolved command string. */
	command: string;
	/** `["/bin/sh", "-c", command]` — the command as a single argv element. */
	argv: string[];
	timeoutMs: number;
	capture?: Record<string, CaptureEntry>;
	/**
	 * Set when the item cannot run at all (empty command, unparseable
	 * timeout). Bootstrap failures are reported, never thrown
	 * (SPEC.md § Failure semantics), so a bad item stays in the plan and
	 * carries its own diagnosis.
	 */
	error?: string;
}

/**
 * Build the bootstrap plan for a launch. Pure — no I/O — so selection,
 * expression resolution, argv shape and timeout handling are unit-testable.
 */
export function planBootstraps(
	launch: NormalizedLaunch,
	context: ResolverContext,
	opts: { component?: string } = {},
): BootstrapPlanItem[] {
	const plan: BootstrapPlanItem[] = [];

	for (const [name, component] of Object.entries(launch.components)) {
		if (opts.component && name !== opts.component) continue;

		// `bootstrap` is mode-invariant (D-38): the same command runs from
		// source or artifact. A path or binary that differs by mode belongs in
		// storage:/env/PATH, not a separate command.
		const bootstrap = component.commands?.bootstrap;
		if (!bootstrap) continue;

		// Resolve $-expressions in the command string (e.g. $app.url) at
		// invocation time. Bootstrap runs after start, so the resolved URL
		// already reflects the actual allocated port. A `$$` escape becomes a
		// literal `$` here and reaches the shell intact (SPEC.md § References).
		const command = resolveExpression(bootstrap.command, context);
		const base = {
			component: name,
			command,
			// `/bin/sh -c <command>` — one argv element, so the shell interprets
			// the command and nothing else (SPEC.md § Command interpretation).
			argv: [BOOTSTRAP_SHELL, "-c", command],
			capture: bootstrap.capture,
		};

		if (command.trim() === "") {
			plan.push({
				...base,
				timeoutMs: DEFAULT_BOOTSTRAP_TIMEOUT_MS,
				error: "empty command",
			});
			continue;
		}

		let timeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS;
		if (bootstrap.timeout !== undefined) {
			try {
				timeoutMs = parseDuration(bootstrap.timeout);
			} catch (err) {
				// An unparseable timeout is surfaced, never silently replaced
				// with a default (PROVIDERS.md §10.10).
				plan.push({
					...base,
					timeoutMs: DEFAULT_BOOTSTRAP_TIMEOUT_MS,
					error: err instanceof Error ? err.message : String(err),
				});
				continue;
			}
		}

		plan.push({ ...base, timeoutMs });
	}

	return plan;
}

/** Minimal exec contract so tests can inject a fake runner. */
export type BootstrapExec = (
	cmd: string,
	args: string[],
	opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Run one command. `cmd`/`args` cross the process boundary as an argv vector
 * with shell:false — the command string is a single element of it, never
 * interpolated into a string another shell would re-parse. Returns the
 * structured result; does not throw on command failure.
 */
const defaultExec: BootstrapExec = (cmd, args, opts) =>
	new Promise((resolveP) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: { ...process.env as Record<string, string>, ...opts.env },
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill("SIGTERM");
				resolveP({
					exitCode: 124,
					stdout,
					stderr: stderr + `\n(killed after ${opts.timeoutMs}ms timeout)`,
				});
			}
		}, opts.timeoutMs);

		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});

		child.on("error", (err) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolveP({ exitCode: 1, stdout, stderr: `${stderr}\n${err.message}` });
			}
		});

		child.on("close", (code) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolveP({ exitCode: code ?? 1, stdout, stderr });
			}
		});
	});

/**
 * Public entry point for `launch bootstrap`. Loads the Launchfile, rebuilds
 * the resolver context from persisted state (so $app.url resolves to the
 * same value the running component sees), resolves $-expressions in each
 * bootstrap command, runs them in declaration order, and returns structured
 * results.
 *
 * Does not fail the process on command error — the caller (CLI) decides
 * how to display failures. This matches the "reported, not deploy-failing"
 * semantics in SPEC.md § Bootstrap stage.
 */
export async function launchBootstrap(
	opts: { component?: string; projectDir?: string; exec?: BootstrapExec } = {},
): Promise<BootstrapResult[]> {
	const projectDir = opts.projectDir ?? process.cwd();

	const launchfileContent = await readFile(join(projectDir, "Launchfile"), "utf8");
	const launch = readLaunch(launchfileContent);
	const state = await loadState(projectDir);

	if (!state) {
		throw new Error("No active launch state. Run `launch up` first.");
	}

	// Rebuild resource map from state so the resolver context has real
	// values at invocation time (same pattern as launchEnv). This calls
	// provisioner.provision() on already-provisioned resources to retrieve
	// their current property values — relies on every provisioner being
	// idempotent: re-running provision() must not corrupt state or
	// re-create the resource. All current provisioners satisfy this; new
	// provisioners must as well.
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
	const context = buildResolverContext(
		resourceMap,
		state.ports,
		state.secrets,
		appProperties,
	);

	const exec = opts.exec ?? defaultExec;
	const plan = planBootstraps(launch, context, { component: opts.component });
	const results: BootstrapResult[] = [];

	for (const item of plan) {
		const name = item.component;

		// Bootstrap failures are reported, not thrown (SPEC.md \u00a7 Failure
		// semantics) \u2014 an unparseable timeout is surfaced the same way,
		// never silently replaced with a default (PROVIDERS.md \u00a710.10).
		if (item.error) {
			console.error(`  \u2717 Bootstrap [${name}]: ${item.error}`);
			results.push({
				component: name,
				command: item.command,
				ok: false,
				exitCode: 1,
				captures: {},
				captureMeta: item.capture ?? {},
				stdout: "",
				stderr: item.error,
			});
			continue;
		}

		// Resolve env vars so the subprocess gets the same environment as
		// the running component. Minted generator values come from the store
		// `up` persists (D-49); a value minted here (a generator declared
		// after the last `up`) is persisted before the command runs, so
		// `up`/`env`/`bootstrap` keep agreeing on it.
		const component = launch.components[name]!;
		const { env, unsupplied } = resolveComponentEnv(component, context, resourceMap);
		const minted = await resolveGenerators(component, env, name, (state.generatedEnv ??= {}));
		if (minted) await saveState(projectDir, state);
		// `up` took its `required:` values from the launching environment; read the
		// same channel so bootstrap really does see the running component's env.
		for (const { key } of unsupplied) {
			const supplied = process.env[key];
			if (supplied !== undefined) env[key] = supplied;
		}

		const port = state.ports[name];
		if (port && !env.PORT) env.PORT = String(port);

		console.log(`\n  \u2193 Bootstrap [${name}]`);
		// `$secrets.*` / `$<resource>.password` / `$<resource>.url` resolve to live
		// credentials here, so the echoed command is scrubbed (CWE-532).
		console.log(`    $ ${redactSecrets(item.command)}`);

		const [file, ...args] = item.argv;
		const { exitCode, stdout, stderr } = await exec(file!, args, {
			cwd: projectDir,
			env,
			timeoutMs: item.timeoutMs,
		});

		const captures = item.capture ? extractCaptures(stdout, item.capture) : {};

		results.push({
			component: name,
			command: item.command,
			ok: exitCode === 0,
			exitCode,
			captures,
			captureMeta: item.capture ?? {},
			stdout,
			stderr,
		});

		// Print captures inline so the user sees them immediately.
		if (Object.keys(captures).length > 0) {
			console.log("\n  Captured:");
			for (const [key, value] of Object.entries(captures)) {
				const meta = item.capture?.[key];
				const displayValue = meta?.sensitive ? "***" : value;
				const desc = meta?.description ? ` — ${meta.description}` : "";
				console.log(`    ${key}: ${displayValue}${desc}`);
			}
		}

		if (exitCode !== 0) {
			console.error(`  \u2717 Bootstrap [${name}] failed with exit code ${exitCode}`);
			if (stderr) console.error(redactSecrets(stderr));
		} else {
			console.log(`  \u2713 Bootstrap [${name}] complete`);
		}
	}

	if (results.length === 0) {
		const target = opts.component ? ` for component "${opts.component}"` : "";
		console.log(`No bootstrap command declared${target}.`);
	}

	return results;
}
