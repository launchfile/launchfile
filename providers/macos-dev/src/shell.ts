/**
 * Command execution helpers with timeout, logging, and structured results.
 *
 * Two entry points, and the difference between them is a security boundary:
 *
 * - `shell(cmd, args, opts)` passes arguments straight to the OS via
 *   `execFile`. No shell is involved, so metacharacters in an argument are
 *   inert. Every command this provider builds itself uses this form — a value
 *   spliced into a command string would be CWE-78.
 * - `shellScript(command, opts)` runs a command string through `/bin/sh -c`.
 *   It exists only for command strings the Launchfile author wrote for their
 *   own app (`commands:`, `health:`, `release:`), where shell syntax is the
 *   documented contract. Never build one of these by interpolation.
 */

import {
	exec as cpExec,
	execFile as cpExecFile,
	type ExecFileOptions,
	type ExecOptions,
} from "node:child_process";
import { redactSecrets } from "./redact.js";

export interface ShellResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ShellOpts {
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
	/** If true, don't log the command being run */
	silent?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

function toResult(
	error: (Error & { code?: unknown }) | null,
	stdout: string | Buffer,
	stderr: string | Buffer,
): ShellResult {
	const result: ShellResult = {
		exitCode: typeof error?.code === "number" ? error.code : 0,
		stdout: typeof stdout === "string" ? stdout : "",
		stderr: typeof stderr === "string" ? stderr : "",
	};
	// Node sets error.code to the exit code on non-zero; a signal or a spawn
	// failure leaves it non-numeric, so surface those as a generic failure.
	if (error && result.exitCode === 0) result.exitCode = 1;
	return result;
}

function failure(display: string, result: ShellResult): Error {
	// The message reaches the user and may be logged by a caller; both the
	// command and the child's stderr can echo a secret back, so neither goes
	// in unscrubbed (D-18, CWE-532).
	return Object.assign(
		new Error(
			`Command failed: ${redactSecrets(display)}\n${redactSecrets(result.stderr)}`,
		),
		{ result },
	);
}

/**
 * Run a command with an argument array. Arguments reach the OS directly, so
 * they are never parsed as shell syntax.
 */
export async function shell(
	cmd: string,
	args: string[],
	opts: ShellOpts & { allowFailure?: boolean } = {},
): Promise<ShellResult> {
	const display = [cmd, ...args].join(" ");
	if (!opts.silent) {
		// An argument can carry a resolved secret (a generated DB password, a
		// credential-bearing URL). Scrub before echo.
		console.log(`  $ ${redactSecrets(display)}`);
	}

	const execOpts: ExecFileOptions = {
		cwd: opts.cwd,
		env: opts.env ? { ...process.env, ...opts.env } : undefined,
		timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
		maxBuffer: MAX_BUFFER,
	};

	return new Promise((resolve, reject) => {
		cpExecFile(cmd, args, execOpts, (error, stdout, stderr) => {
			const result = toResult(error, stdout, stderr);
			if (error && !opts.allowFailure) reject(failure(display, result));
			else resolve(result);
		});
	});
}

/** Run a command with an argument array, return true if exit code is 0. */
export async function shellOk(
	cmd: string,
	args: string[],
	opts?: ShellOpts,
): Promise<boolean> {
	const result = await shell(cmd, args, {
		...opts,
		allowFailure: true,
		silent: true,
	});
	return result.exitCode === 0;
}

/**
 * Run an author-written command string through `/bin/sh -c`.
 *
 * The shell is the point here: `commands:`, `health:` and `release:` values are
 * documented as shell commands, and app authors rely on pipes, `&&` and
 * variable expansion in them. The string must come from the Launchfile
 * verbatim — building one by interpolating a value makes it injectable.
 */
export async function shellScript(
	command: string,
	opts: ShellOpts & { allowFailure?: boolean } = {},
): Promise<ShellResult> {
	if (!opts.silent) {
		console.log(`  $ ${redactSecrets(command)}`);
	}

	const execOpts: ExecOptions = {
		cwd: opts.cwd,
		env: opts.env ? { ...process.env, ...opts.env } : undefined,
		timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
		maxBuffer: MAX_BUFFER,
	};

	return new Promise((resolve, reject) => {
		cpExec(command, execOpts, (error, stdout, stderr) => {
			const result = toResult(error, stdout, stderr);
			if (error && !opts.allowFailure) reject(failure(command, result));
			else resolve(result);
		});
	});
}
