/**
 * Shell execution helper with timeout, logging, and structured results.
 */

import { exec as cpExec, type ExecOptions } from "node:child_process";

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

/**
 * Run a shell command and return structured output.
 * Throws on non-zero exit code unless `allowFailure` is set.
 */
export async function shell(
	command: string,
	opts: ShellOpts & { allowFailure?: boolean } = {},
): Promise<ShellResult> {
	if (!opts.silent) {
		console.log(`  $ ${command}`);
	}

	const execOpts: ExecOptions = {
		cwd: opts.cwd,
		env: opts.env ? { ...process.env, ...opts.env } : undefined,
		timeout: opts.timeout ?? 120_000,
		maxBuffer: 10 * 1024 * 1024,
	};

	return new Promise((resolve, reject) => {
		cpExec(command, execOpts, (error, stdout, stderr) => {
			const result: ShellResult = {
				exitCode: error?.code ?? (typeof error?.code === "number" ? error.code : 0),
				stdout: typeof stdout === "string" ? stdout : "",
				stderr: typeof stderr === "string" ? stderr : "",
			};

			// Node's exec sets error.code to the exit code on non-zero
			if (error && result.exitCode === 0) {
				result.exitCode = 1;
			}

			if (error && !opts.allowFailure) {
				reject(
					Object.assign(new Error(`Command failed: ${command}\n${result.stderr}`), {
						result,
					}),
				);
			} else {
				resolve(result);
			}
		});
	});
}

/** Run a command, return true if exit code is 0 */
export async function shellOk(command: string, opts?: ShellOpts): Promise<boolean> {
	const result = await shell(command, { ...opts, allowFailure: true, silent: true });
	return result.exitCode === 0;
}
