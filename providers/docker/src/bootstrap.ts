/**
 * Bootstrap command execution for the Docker provider.
 *
 * Implements the `commands.bootstrap` lifecycle stage introduced by D-34
 * against a running docker compose project. Commands are argv-split and
 * run via `docker compose -p <project> exec -T <service> <argv...>` with
 * spawn({ shell: false }), avoiding shell-injection exposure. Stdout is
 * captured against the regex patterns declared in commands.bootstrap.capture.
 *
 * Spec: /spec/SPEC.md § Bootstrap stage.
 */

import { spawn } from "node:child_process";
import {
	resolveExpression,
	type CaptureEntry,
	type NormalizedLaunch,
	type ResolverContext,
} from "@launchfile/sdk";
import { loadState, composeProject } from "./state.js";

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

/** Parse a duration string like "5m" into milliseconds. Exported for testing. */
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
 * Compute $app.* properties for the Docker provider. Mirrors the private
 * helper inside compose-generator.ts so bootstrap can resolve $app.url
 * against the same values compose-generator used when writing env vars
 * into the compose file.
 */
function computeAppProperties(
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
	return {
		name: launch.name,
		host: "localhost",
		port: primaryPort,
		url: primaryPort > 0 ? `http://localhost:${primaryPort}` : "",
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

interface RunOpts {
	cwd?: string;
	timeoutMs: number;
}

async function runDockerExec(
	composeProjectName: string,
	service: string,
	argv: string[],
	opts: RunOpts,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const dockerArgs = [
		"compose",
		"-p",
		composeProjectName,
		"exec",
		"-T",
		service,
		...argv,
	];

	return new Promise((resolveP) => {
		const child = spawn("docker", dockerArgs, {
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
}): Promise<BootstrapResult[]> {
	const state = await loadState(opts.slug);
	if (!state) {
		throw new Error(`No docker state found for "${opts.slug}". Run \`launchfile up\` first.`);
	}

	const project = composeProject(opts.slug);
	const appProperties = computeAppProperties(opts.launch, state.ports);
	const resolverContext: ResolverContext = {
		secrets: state.secrets,
		app: appProperties,
	};

	const results: BootstrapResult[] = [];

	for (const [name, component] of Object.entries(opts.launch.components)) {
		if (opts.component && name !== opts.component) continue;

		const bootstrap = component.commands?.bootstrap;
		if (!bootstrap) continue;

		// Resolve $-expressions in the command string so $app.url becomes
		// http://localhost:<hostPort> before argv split.
		const resolvedCommand = resolveExpression(bootstrap.command, resolverContext);
		const argv = resolvedCommand.trim().split(/\s+/).filter(Boolean);
		if (argv.length === 0) {
			results.push({
				component: name,
				service: serviceNameFor(opts.launch.name, name),
				command: resolvedCommand,
				ok: false,
				exitCode: 1,
				captures: {},
				captureMeta: bootstrap.capture ?? {},
				stdout: "",
				stderr: "empty command",
			});
			continue;
		}

		const service = serviceNameFor(opts.launch.name, name);
		console.log(`\n  \u2193 Bootstrap [${name}] via docker compose exec ${service}`);
		console.log(`    $ ${resolvedCommand}`);

		const { exitCode, stdout, stderr } = await runDockerExec(
			project,
			service,
			argv,
			{
				timeoutMs: bootstrap.timeout ? parseDuration(bootstrap.timeout) : 120_000,
			},
		);

		const captures = bootstrap.capture ? extractCaptures(stdout, bootstrap.capture) : {};

		results.push({
			component: name,
			service,
			command: resolvedCommand,
			ok: exitCode === 0,
			exitCode,
			captures,
			captureMeta: bootstrap.capture ?? {},
			stdout,
			stderr,
		});

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
