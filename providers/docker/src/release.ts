/**
 * Release command execution for the Docker provider.
 *
 * Implements the `release` lifecycle stage per SPEC.md § Failure semantics
 * and PROVIDERS.md §10.10: a declared `release` runs after the component's
 * required resources are ready and before `start`, and a failure fails the
 * deploy. Each release runs as a one-shot container via
 * `docker compose run --rm <service> <argv...>` — compose brings the
 * service's `depends_on` up first and waits on their `service_healthy`
 * conditions, so backing resources are provisioned and healthy before the
 * command executes, while the app service itself is not yet started.
 *
 * The command runs through a POSIX shell inside the container
 * (SPEC.md § Command interpretation), so `&&`, pipes, redirection and
 * variable expansion behave as authors write them. The string is passed as a
 * single argv element to `sh -c` — it is never interpolated into a shell
 * string on this side, so nothing the app declares can affect the compose
 * invocation itself.
 */

import {
	type CaptureEntry,
	type NormalizedLaunch,
	parseDurationMs,
	type ResolverContext,
	resolveExpression,
} from "@launchfile/sdk";
import { computeAppProperties, extractCaptures } from "./bootstrap.js";
import { redactSecrets, registerSecrets } from "./redact.js";
import { shell } from "./shell.js";

/** Default budget for a release one-shot when no `timeout` is declared. */
export const DEFAULT_RELEASE_TIMEOUT_MS = 600_000;

/** One planned release execution, in run order. */
export interface ReleasePlanItem {
	component: string;
	service: string;
	/** The $-resolved command string. */
	command: string;
	argv: string[];
	timeoutMs: number;
	capture?: Record<string, CaptureEntry>;
}

/**
 * Order component names so that every `depends_on` target comes before its
 * dependents (declaration order otherwise). Releases run in this order, so
 * when `compose run` pulls a depended-on component up as a dependency, that
 * component's own release has already executed — "release before the
 * component serves" holds for every component. Cycles are broken by
 * falling back to declaration order for the remainder (compose itself
 * would reject a cyclic graph at `up` time).
 */
export function dependencyOrder(launch: NormalizedLaunch): string[] {
	const names = Object.keys(launch.components);
	const ordered: string[] = [];
	const done = new Set<string>();
	const visiting = new Set<string>();

	const visit = (name: string): void => {
		if (done.has(name) || visiting.has(name)) return;
		visiting.add(name);
		for (const dep of launch.components[name]?.depends_on ?? []) {
			if (launch.components[dep.component]) visit(dep.component);
		}
		visiting.delete(name);
		done.add(name);
		ordered.push(name);
	};

	for (const name of names) visit(name);
	return ordered;
}

/**
 * Build the ordered release plan for a deploy. Pure — no I/O — so ordering,
 * selection, expression resolution, and timeout handling are unit-testable.
 *
 * Throws on an unparseable `timeout` (PROVIDERS.md §10.10: surface the
 * error, never substitute a default) and on a release command that
 * resolves to nothing — release failures fail the deploy, and a plan that
 * cannot be built is such a failure.
 */
export function planReleases(
	launch: NormalizedLaunch,
	opts: {
		/** Component name → generated compose service name (from launchToCompose). */
		services: Record<string, string>;
		/** Component name → allocated host port (for $app.* resolution). */
		hostPorts: Record<string, number>;
		secrets: Record<string, string>;
		/** Restrict to these components (the D-41 start-set); undefined = all. */
		only?: ReadonlySet<string>;
	},
): ReleasePlanItem[] {
	// `$secrets.*` resolves to live credentials below, and the resolved string
	// is echoed and can be echoed back by the container. Register the values
	// before any of them can reach a sink (D-18, CWE-532).
	registerSecrets(Object.values(opts.secrets));

	const resolverContext: ResolverContext = {
		secrets: opts.secrets,
		app: computeAppProperties(launch, opts.hostPorts),
	};

	const plan: ReleasePlanItem[] = [];
	for (const name of dependencyOrder(launch)) {
		if (opts.only && !opts.only.has(name)) continue;
		const service = opts.services[name];
		if (!service) continue; // component was skipped by the generator

		const release = launch.components[name]?.commands?.release;
		if (!release?.command) continue;

		const command = resolveExpression(release.command, resolverContext);
		if (command.trim() === "") {
			throw new Error(`release [${name}]: command resolved to an empty string`);
		}
		// `sh -c <command>` — one argv element, so the shell interprets the
		// command and nothing else (SPEC.md § Command interpretation).
		const argv = ["sh", "-c", command];

		let timeoutMs = DEFAULT_RELEASE_TIMEOUT_MS;
		if (release.timeout !== undefined) {
			try {
				timeoutMs = parseDurationMs(release.timeout);
			} catch (err) {
				throw new Error(
					`release [${name}]: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		plan.push({
			component: name,
			service,
			command,
			argv,
			timeoutMs,
			capture: release.capture,
		});
	}
	return plan;
}

/** Minimal exec contract so tests can inject a fake runner. */
export type ReleaseExec = (
	cmd: string,
	args: string[],
	opts: { timeout: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const defaultExec: ReleaseExec = (cmd, args, opts) =>
	shell(cmd, args, { timeout: opts.timeout, allowFailure: true, silent: true });

/**
 * Execute the release plan sequentially. Throws on the first failure —
 * the caller aborts the deploy before any app service starts.
 */
export async function runReleases(
	plan: ReleasePlanItem[],
	opts: { project: string; composeFile: string; exec?: ReleaseExec },
): Promise<void> {
	const exec = opts.exec ?? defaultExec;

	for (const item of plan) {
		console.log(
			`  ↓ Release [${item.component}] via docker compose run --rm ${item.service}`,
		);
		// The command is $-resolved, so `$secrets.*` is a live credential by
		// this point — scrub before echo (D-18, CWE-532).
		console.log(`    $ ${redactSecrets(item.command)}`);

		const { exitCode, stdout, stderr } = await exec(
			"docker",
			[
				"compose",
				"-p",
				opts.project,
				"-f",
				opts.composeFile,
				"run",
				"--rm",
				"-T",
				item.service,
				...item.argv,
			],
			{ timeout: item.timeoutMs },
		);

		if (exitCode !== 0) {
			// The child can echo a credential back in its own diagnostics.
			if (stdout.trim()) console.error(redactSecrets(stdout.trim()));
			if (stderr.trim()) console.error(redactSecrets(stderr.trim()));
			// `compose run` output is the only record of why a migration failed,
			// and it is discarded once this frame unwinds. Carry it on the error
			// so the failure capture (#44) can keep the tail. The command AND the
			// tails travel in redacted form — `$secrets.*` is resolved by now, and
			// the span logger serializes this error whole on failure, so a raw
			// tail here would reach stderr and the opt-in NDJSON file (D-18,
			// CWE-532).
			throw Object.assign(
				new Error(
					`release [${item.component}] failed with exit code ${exitCode} — deploy aborted`,
				),
				{
					result: {
						exitCode,
						stdout: redactSecrets(stdout),
						stderr: redactSecrets(stderr),
					},
					display: redactSecrets(item.command),
				},
			);
		}

		if (item.capture) {
			const captures = extractCaptures(stdout, item.capture);
			if (Object.keys(captures).length > 0) {
				console.log("  Captured:");
				for (const [key, value] of Object.entries(captures)) {
					const meta = item.capture[key];
					const displayValue = meta?.sensitive ? "***" : value;
					const desc = meta?.description ? ` — ${meta.description}` : "";
					console.log(`    ${key}: ${displayValue}${desc}`);
				}
			}
		}

		console.log(`  ✓ Release [${item.component}] complete`);
	}
}
