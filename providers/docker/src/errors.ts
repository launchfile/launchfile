/**
 * Launch-failure capture for the Docker provider.
 *
 * The SDK owns the shape (`LaunchErrorContext`) and the D-48 disposition table;
 * this module owns the docker-specific half: which redactor runs, how a storage
 * key is derived, which log tails are worth keeping, and the wrapper that tags a
 * throw with the phase it happened in.
 *
 * Everything captured here is scrubbed **in this process**, at the moment of
 * capture. `redactSecrets` matches against a process-global in-memory registry
 * that is populated during the run; a reader started later has an empty registry
 * and can scrub nothing, so text that leaves this module unredacted is
 * unredactable from then on (D-18, CWE-532).
 */

import { createHash } from "node:crypto";
import {
	buildLaunchErrorContext,
	isLaunchError,
	LaunchError,
	type LaunchErrorInput,
	type LaunchPhase,
	type NormalizedLaunch,
} from "@launchfile/sdk";
import { isExpectedRefusal } from "./logger.js";
import { redactSecrets } from "./redact.js";
import { shell, type ShellResult } from "./shell.js";

export const DOCKER_PROVIDER = "docker";

/** How many trailing log lines to ask docker for. The SDK trims again on capture. */
const LOG_TAIL = 200;

/**
 * The storage key a failure record is filed under.
 *
 * The slug once one exists. Before that — a `resolve` or `parse` failure, where
 * there is no slug and no deployment id yet — a short hash of the source string,
 * so the pre-deploy failures still land somewhere retrievable rather than
 * nowhere.
 */
export function dockerErrorKey(opts: { slug?: string; source?: string }): string {
	if (opts.slug) return opts.slug;
	const source = opts.source ?? "";
	return `src-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
}

/** Build a docker `LaunchError`, redacting every captured string on the way in. */
export function dockerLaunchError(
	input: Omit<LaunchErrorInput, "provider">,
): LaunchError {
	return new LaunchError(
		buildLaunchErrorContext({ ...input, provider: DOCKER_PROVIDER }, redactSecrets),
	);
}

/**
 * The env var **names** a component declares — its own `env:` keys plus the keys
 * every `requires[].set_env` wiring writes. Read from the Launchfile, not from a
 * resolved env map, so no resolved value is ever in scope at the call site.
 * Omitting `component` unions every component's declarations.
 */
export function declaredEnvKeys(
	launch: NormalizedLaunch,
	component?: string,
): Record<string, 0> {
	const keys: Record<string, 0> = {};
	for (const [name, comp] of Object.entries(launch.components)) {
		if (component && name !== component) continue;
		for (const key of Object.keys(comp.env ?? {})) keys[key] = 0;
		for (const req of comp.requires ?? []) {
			for (const key of Object.keys(req.set_env ?? {})) keys[key] = 0;
		}
	}
	return keys;
}

/**
 * Tail the compose project's container logs so a `run` or `health` failure
 * carries the app's own output, not just docker's exit code.
 *
 * One combined call rather than one per service: this runs on a path that has
 * already failed, and each extra docker invocation is another thing that can
 * hang. Compose prefixes each line with its service name, so the combined tail
 * stays attributable. Returns nothing on failure — a missing tail is a worse
 * diagnosis, not a worse failure.
 */
export async function captureComposeLogs(
	project: string,
	composeFile: string,
): Promise<Record<string, string> | undefined> {
	try {
		const result = await shell(
			"docker",
			[
				"compose",
				"-p",
				project,
				"-f",
				composeFile,
				"logs",
				"--no-color",
				"--tail",
				String(LOG_TAIL),
			],
			{ allowFailure: true, silent: true, timeout: 30_000 },
		);
		const text = result.stdout.trim() || result.stderr.trim();
		return text ? { compose: text } : undefined;
	} catch {
		return undefined;
	}
}

/** What a phase wrapper knows about the launch it is wrapping. */
export interface PhaseContext {
	key: string;
	app?: string;
	slug?: string;
	component?: string;
	/** An env map whose keys are captured. Values never leave this call. */
	env?: Readonly<Record<string, unknown>>;
	warnings?: readonly string[];
	/** Called only on failure, to attach log tails. */
	logs?: () => Promise<Record<string, string> | undefined>;
}

/**
 * Run `fn`, and on failure re-throw it as a `LaunchError` tagged with `phase`.
 *
 * The phase is attached at the throw site, where it is known — a top-level catch
 * would have to guess it from the message. A `LaunchError` thrown by an inner
 * wrapper passes through untouched, so the innermost (most specific) phase wins.
 */
export async function inPhase<T>(
	phase: LaunchPhase,
	context: PhaseContext,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (isLaunchError(err)) throw err;
		// A deliberate refusal (`ExpectedRefusal`, e.g. an unsupplied `required:`
		// variable, D-52) carries its own type and actionable message — callers
		// match on the type, so it propagates unwrapped instead of becoming a
		// phase-tagged record.
		if (isExpectedRefusal(err)) throw err;
		throw await launchErrorFrom(phase, context, err);
	}
}

/**
 * Convert an arbitrary thrown value into a `LaunchError` for `phase`.
 *
 * `shell()` attaches the command result and the already-redacted display string
 * to the errors it rejects with; both are lifted here so the record carries the
 * exit code and output tails without re-running anything. The command captured
 * is the redacted form the provider echoed — never the pre-scrub string (D-18).
 */
export async function launchErrorFrom(
	phase: LaunchPhase,
	context: PhaseContext,
	err: unknown,
): Promise<LaunchError> {
	const error = err instanceof Error ? err : new Error(String(err));
	const carrier = error as { result?: ShellResult; display?: string };
	const logs = context.logs ? await context.logs().catch(() => undefined) : undefined;

	return dockerLaunchError({
		phase,
		key: context.key,
		app: context.app,
		slug: context.slug,
		component: context.component,
		message: error.message,
		command: carrier.display,
		exitCode: carrier.result?.exitCode,
		stdout: carrier.result?.stdout,
		stderr: carrier.result?.stderr,
		serviceLogs: logs,
		env: context.env,
		warnings: context.warnings,
	});
}
