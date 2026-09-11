/**
 * Launch-failure capture for the macOS dev provider — the mirror of
 * `providers/docker/src/errors.ts`.
 *
 * The SDK owns the shape (`LaunchErrorContext`) and the D-48 disposition table;
 * this module owns the macos-dev half: which redactor runs, how a storage key is
 * derived, which log tails are worth keeping, and the wrapper that tags a throw
 * with the phase it happened in. One shared context shape rather than a private
 * per-provider one is P-5: the same Launchfile failing under either provider
 * produces the same record, so `launchfile diagnose` reads one format.
 *
 * Everything captured here is scrubbed **in this process**, at the moment of
 * capture. `redactSecrets` matches against a process-global in-memory registry
 * populated during the run; a reader started later has an empty registry and can
 * scrub nothing, so text that leaves this module unredacted is unredactable from
 * then on (D-18, CWE-532).
 *
 * The one deliberate difference from the docker module is the key. A docker
 * deployment is identified by its slug; a macos-dev deployment is identified by
 * its **project directory** — the provider keeps state in
 * `<projectDir>/.launchfile/state.json` and refuses `--name` because it runs one
 * instance per directory. Keying a record by app name would make two checkouts
 * of the same app share one record and lose the loser's diagnosis, which is the
 * concurrency case PROVIDERS.md §9 calls out.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	buildLaunchErrorContext,
	isLaunchError,
	LaunchError,
	type LaunchErrorInput,
	type LaunchPhase,
	type NormalizedLaunch,
	sourceErrorKey,
} from "@launchfile/sdk";
import { redactSecrets } from "./redact.js";

export const MACOS_PROVIDER = "macos-dev";

/** How many trailing log lines to read back per component. The SDK trims again. */
const LOG_TAIL = 200;

/**
 * The storage key a failure record is filed under: the project directory, which
 * is this provider's unit of identity. Derived through the SDK helper so the
 * provider that writes the record and the CLI that later clears or reads it
 * cannot drift apart.
 */
export function macosErrorKey(projectDir: string): string {
	return sourceErrorKey(projectDir);
}

/** Build a macos-dev `LaunchError`, redacting every captured string on the way in. */
export function macosLaunchError(
	input: Omit<LaunchErrorInput, "provider">,
): LaunchError {
	return new LaunchError(
		buildLaunchErrorContext({ ...input, provider: MACOS_PROVIDER }, redactSecrets),
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
 * Tail the per-component log files `ProcessManager` writes, so a `run` failure
 * carries the app's own output and not just a spawn error.
 *
 * This is the macos-dev counterpart of docker's `compose logs`: the processes
 * are on this host and their output is already on disk at
 * `<projectDir>/.launchfile/logs/<component>.log`. A component whose log is
 * missing or unreadable is skipped — a missing tail is a worse diagnosis, not a
 * worse failure.
 */
export async function captureProcessLogs(
	projectDir: string,
	components: readonly string[],
): Promise<Record<string, string> | undefined> {
	const logs: Record<string, string> = {};
	for (const name of components) {
		try {
			const text = await readFile(
				join(projectDir, ".launchfile", "logs", `${name}.log`),
				"utf8",
			);
			const tail = text.split("\n").slice(-LOG_TAIL).join("\n").trim();
			if (tail) logs[name] = tail;
		} catch {
			// No log file for this component — it may never have spawned.
		}
	}
	return Object.keys(logs).length > 0 ? logs : undefined;
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
 *
 * A deliberate refusal passes through unwrapped. The D-50 storage refusals carry
 * the SDK's `expectedRefusal` marker, the CLI matches them by `instanceof` to
 * print their own actionable message, and wrapping one would both break that
 * match and file an operator-fixable precondition as a launch failure.
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
		if (isExpectedRefusal(err)) throw err;
		throw await launchErrorFrom(phase, context, err);
	}
}

/**
 * Whether a thrown value marks itself an expected refusal — an operator-fixable
 * precondition the CLI has an actionable message for, not a crash. Mirrors the
 * docker provider's check, which lives in its logger module; this provider has
 * no logger to put it in.
 */
export function isExpectedRefusal(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { expectedRefusal?: unknown }).expectedRefusal === true
	);
}

/**
 * Convert an arbitrary thrown value into a `LaunchError` for `phase`.
 *
 * `shell()` and `shellScript()` attach the command result and the
 * already-redacted display string to the errors they reject with; both are
 * lifted here so the record carries the exit code and output tails without
 * re-running anything. The command captured is the redacted form the provider
 * echoed — never the pre-scrub string (D-18).
 */
export async function launchErrorFrom(
	phase: LaunchPhase,
	context: PhaseContext,
	err: unknown,
): Promise<LaunchError> {
	const error = err instanceof Error ? err : new Error(String(err));
	const carrier = error as {
		result?: { exitCode: number; stdout: string; stderr: string };
		display?: string;
	};
	const logs = context.logs
		? await context.logs().catch(() => undefined)
		: undefined;

	return macosLaunchError({
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
