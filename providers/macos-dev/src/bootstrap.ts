/**
 * Bootstrap command execution for the macOS Dev provider.
 *
 * Implements the `commands.bootstrap` lifecycle stage introduced by D-34:
 * user-invoked, runs after `start` against the running component, captures
 * stdout via regex patterns, re-runnable, and reports failures rather than
 * deploy-failing. Spec: /spec/SPEC.md § Bootstrap stage.
 *
 * The command is split into argv via whitespace and run through spawn()
 * with shell:false to avoid shell-injection exposure. This means shell
 * metacharacters (pipes, redirects, &&, quoted args with spaces) are not
 * supported — apps that need shell features should wrap them in an
 * image-level script and invoke that script.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
	readLaunch,
	resolveExpression,
	type CaptureEntry,
} from "@launchfile/sdk";
import { loadState } from "./state.js";
import {
	buildResolverContext,
	computeAppProperties,
	resolveComponentEnv,
	resolveGenerators,
} from "./env-writer.js";
import { getProvisioner, type ResourceProperties } from "./resources/index.js";

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

/** Parse a simple duration string like "5m", "30s", "1h" into milliseconds. Exported for unit testing. */
export function parseDuration(s: string): number {
	const match = /^(\d+)\s*(ms|s|m|h)$/.exec(s.trim());
	if (!match) return 120_000;
	const n = Number.parseInt(match[1]!, 10);
	switch (match[2]) {
		case "ms": return n;
		case "s": return n * 1000;
		case "m": return n * 60 * 1000;
		case "h": return n * 60 * 60 * 1000;
		default: return 120_000;
	}
}

/**
 * Run one command using argv-split (no-shell) execution. Returns the
 * structured result; does not throw on command failure.
 */
async function runOnce(
	command: string,
	opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const parts = command.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		return { exitCode: 1, stdout: "", stderr: "empty command" };
	}
	const [file, ...args] = parts;

	return new Promise((resolveP) => {
		const child = spawn(file!, args, {
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
}

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
	opts: { component?: string; projectDir?: string } = {},
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

	const results: BootstrapResult[] = [];

	for (const [name, component] of Object.entries(launch.components)) {
		if (opts.component && name !== opts.component) continue;

		const bootstrap = component.commands?.bootstrap;
		if (!bootstrap) continue;

		// Resolve $-expressions in the command string (e.g. $app.url) at
		// invocation time. Bootstrap runs after start, so the resolved URL
		// already reflects the actual allocated port.
		const resolvedCommand = resolveExpression(bootstrap.command, context);

		// Resolve env vars so the subprocess gets the same environment as
		// the running component.
		const env = resolveComponentEnv(component, context, resourceMap);
		await resolveGenerators(component, env);
		const port = state.ports[name];
		if (port && !env.PORT) env.PORT = String(port);

		console.log(`\n  \u2193 Bootstrap [${name}]`);
		console.log(`    $ ${resolvedCommand}`);

		const { exitCode, stdout, stderr } = await runOnce(resolvedCommand, {
			cwd: projectDir,
			env,
			timeoutMs: bootstrap.timeout ? parseDuration(bootstrap.timeout) : 120_000,
		});

		const captures = bootstrap.capture
			? extractCaptures(stdout, bootstrap.capture)
			: {};

		const result: BootstrapResult = {
			component: name,
			command: resolvedCommand,
			ok: exitCode === 0,
			exitCode,
			captures,
			captureMeta: bootstrap.capture ?? {},
			stdout,
			stderr,
		};
		results.push(result);

		// Print captures inline so the user sees them immediately.
		if (Object.keys(captures).length > 0) {
			console.log("\n  Captured:");
			for (const [key, value] of Object.entries(captures)) {
				const meta = bootstrap.capture?.[key];
				const displayValue = meta?.sensitive ? "***" : value;
				const desc = meta?.description ? ` — ${meta.description}` : "";
				console.log(`    ${key}: ${displayValue}${desc}`);
			}
		}

		if (exitCode !== 0) {
			console.error(`  \u2717 Bootstrap [${name}] failed with exit code ${exitCode}`);
			if (stderr) console.error(stderr);
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
