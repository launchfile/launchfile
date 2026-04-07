/**
 * Shell execution helper with timeout and structured results.
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
	silent?: boolean;
}

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

export async function shellOk(command: string, opts?: ShellOpts): Promise<boolean> {
	const result = await shell(command, { ...opts, allowFailure: true, silent: true });
	return result.exitCode === 0;
}
