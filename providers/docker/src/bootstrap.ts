/**
 * Bootstrap command execution for the Docker provider.
 *
 * Implements the `commands.bootstrap` lifecycle stage introduced by D-34
 * against a running docker compose project, via
 * `docker compose -p <project> exec -T <service> sh -c <command>`.
 *
 * The command runs through a POSIX shell inside the container
 * (SPEC.md § Command interpretation), so `&&`, `;`, pipes, redirection,
 * grouping and variable expansion behave as authors write them. The string is
 * passed as a single argv element to `sh -c` — it is never interpolated into a
 * shell string on this side, so nothing the app declares can affect the compose
 * invocation itself. Stdout is captured against the regex patterns declared in
 * commands.bootstrap.capture.
 *
 * Spec: /spec/SPEC.md § Bootstrap stage, /spec/PROVIDERS.md §10 item 11.
 */

import { spawn } from "node:child_process";
import {
	deriveAppUrlProperties,
	parseDurationMs,
	resolveExpression,
	type CaptureEntry,
	type NormalizedLaunch,
	type ResolverContext,
} from "@launchfile/sdk";
import { redactSecrets } from "./redact.js";
import { loadState, composeProject } from "./state.js";

/** Default budget for a bootstrap command when no `timeout` is declared. */
export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 120_000;

/** Result of running one bootstrap command against a compose service. */
export interface BootstrapResult {
	component: string;
	service: string;
	command: string;
	ok: boolean;
	exitCode: number;
	captures: Record<string, string>;
	captureMeta: Record<string, CaptureEntry>;
	stdout: string;
	stderr: string;
}

/** One planned bootstrap execution, in component declaration order. */
export interface BootstrapPlanItem {
	component: string;
	service: string;
	/** The $-resolved command string. */
	command: string;
	/** `["sh", "-c", command]` — the command as a single argv element. */
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

function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI match
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "");
}

/** Apply capture patterns to stdout. Exported for unit testing. */
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
			// Invalid regex — skip.
		}
	}
	return result;
}

/**
 * Parse a duration string like "5m" into milliseconds using the ratified
 * grammar (D-48). Throws on an unparseable value — PROVIDERS.md §10.10
 * forbids silently substituting a default. Re-exported for unit testing.
 */
export const parseDuration = parseDurationMs;

/**
 * Compute the full `$app.*` set (D-33, D-35) for the Docker provider. Mirrors
 * the private helper inside compose-generator.ts — same primary-component rule,
 * same URL, and the same `authority`/`scheme`/`tls` trio derived from it via
 * the SDK — so bootstrap (and release) resolve `$app.*` against exactly the
 * values compose-generator used when writing env vars into the compose file.
 */
export function computeAppProperties(
	launch: NormalizedLaunch,
	hostPorts: Record<string, number>,
): Record<string, string | number> {
	let primaryPort = 0;
	for (const [name, component] of Object.entries(launch.components)) {
		const exposed = component.provides?.filter((p) => p.exposed !== false) ?? [];
		if (exposed.length === 0) continue;
		primaryPort = hostPorts[name] ?? exposed[0]!.port;
		break;
	}
	const url = primaryPort > 0 ? `http://localhost:${primaryPort}` : "";
	return {
		name: launch.name,
		host: "localhost",
		port: primaryPort,
		url,
		...deriveAppUrlProperties(url),
	};
}

/**
 * Map a component name to its compose service name. Mirrors the service-
 * naming rule in compose-generator.ts: the implicit "default" component of
 * a single-component app becomes a service named after launch.name;
 * named components become "<launch.name>-<componentName>".
 */
function serviceNameFor(launchName: string, componentName: string): string {
	return componentName === "default" ? launchName : `${launchName}-${componentName}`;
}

/**
 * Build the bootstrap plan for a deployment. Pure — no I/O — so selection,
 * expression resolution, argv shape and timeout handling are unit-testable.
 */
export function planBootstraps(
	launch: NormalizedLaunch,
	opts: {
		/** Component name → allocated host port (for $app.* resolution). */
		hostPorts: Record<string, number>;
		secrets: Record<string, string>;
		/** Restrict to this single component; undefined = all. */
		component?: string;
	},
): BootstrapPlanItem[] {
	const resolverContext: ResolverContext = {
		secrets: opts.secrets,
		app: computeAppProperties(launch, opts.hostPorts),
	};

	const plan: BootstrapPlanItem[] = [];
	for (const [name, component] of Object.entries(launch.components)) {
		if (opts.component && name !== opts.component) continue;

		const bootstrap = component.commands?.bootstrap;
		if (!bootstrap) continue;

		// Resolve $-expressions in the command string so $app.url becomes
		// http://localhost:<hostPort> before the shell sees it. A `$$` escape
		// becomes a literal `$` here and reaches the shell intact (SPEC.md
		// § References, `$$`).
		const command = resolveExpression(bootstrap.command, resolverContext);
		const service = serviceNameFor(launch.name, name);
		const base = {
			component: name,
			service,
			command,
			// `sh -c <command>` — one argv element, so the shell interprets the
			// command and nothing else (SPEC.md § Command interpretation).
			argv: ["sh", "-c", command],
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
	opts: { timeoutMs: number; cwd?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const defaultExec: BootstrapExec = (cmd, args, opts) =>
	new Promise((resolveP) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
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
 * Execute a bootstrap plan against a running compose project. Every item
 * runs; a failure is reported in its result and never thrown
 * (SPEC.md § Failure semantics).
 */
export async function runBootstraps(
	plan: BootstrapPlanItem[],
	opts: { project: string; cwd?: string; exec?: BootstrapExec },
): Promise<BootstrapResult[]> {
	const exec = opts.exec ?? defaultExec;
	const results: BootstrapResult[] = [];

	for (const item of plan) {
		if (item.error) {
			console.error(`  ✗ Bootstrap [${item.component}]: ${item.error}`);
			results.push({
				component: item.component,
				service: item.service,
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

		console.log(
			`\n  ↓ Bootstrap [${item.component}] via docker compose exec ${item.service}`,
		);
		// `$secrets.*` / `$<resource>.password` / `$<resource>.url` resolve to
		// live credentials here, so the echoed command is scrubbed (CWE-532).
		console.log(`    $ ${redactSecrets(item.command)}`);

		const { exitCode, stdout, stderr } = await exec(
			"docker",
			[
				"compose",
				"-p",
				opts.project,
				"exec",
				"-T",
				item.service,
				...item.argv,
			],
			{ timeoutMs: item.timeoutMs, cwd: opts.cwd },
		);

		const captures = item.capture ? extractCaptures(stdout, item.capture) : {};

		results.push({
			component: item.component,
			service: item.service,
			command: item.command,
			ok: exitCode === 0,
			exitCode,
			captures,
			captureMeta: item.capture ?? {},
			stdout,
			stderr,
		});

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
			console.error(
				`  ✗ Bootstrap [${item.component}] failed with exit code ${exitCode}`,
			);
			if (stderr) console.error(redactSecrets(stderr));
		} else {
			console.log(`  ✓ Bootstrap [${item.component}] complete`);
		}
	}

	return results;
}

/**
 * Run `commands.bootstrap` against a running docker compose deployment.
 * The caller is responsible for parsing the Launchfile — the docker
 * provider does not re-read it from disk because the source location
 * isn't persisted in docker state.
 */
export async function dockerBootstrap(opts: {
	launch: NormalizedLaunch;
	slug: string;
	component?: string;
	exec?: BootstrapExec;
}): Promise<BootstrapResult[]> {
	const state = await loadState(opts.slug);
	if (!state) {
		throw new Error(`No docker state found for "${opts.slug}". Run \`launchfile up\` first.`);
	}

	const plan = planBootstraps(opts.launch, {
		hostPorts: state.ports,
		secrets: state.secrets,
		component: opts.component,
	});

	const results = await runBootstraps(plan, {
		project: composeProject(opts.slug),
		exec: opts.exec,
	});

	if (results.length === 0) {
		const target = opts.component ? ` for component "${opts.component}"` : "";
		console.log(`No bootstrap command declared${target}.`);
	}

	return results;
}
