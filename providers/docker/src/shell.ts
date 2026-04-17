/**
 * Shell execution helper with timeout and structured results.
 */

import { execFile as cpExecFile, type ExecFileOptions } from "node:child_process";
import { getLogger } from "./logger.js";

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
	cmd: string,
	args: string[],
	opts: ShellOpts & { allowFailure?: boolean } = {},
): Promise<ShellResult> {
	const display = [cmd, ...args].join(" ");
	if (!opts.silent) {
		console.log(`  $ ${display}`);
	}

	const log = getLogger();
	log.debug({ cmd, args, cwd: opts.cwd }, "shell exec");
	const t0 = performance.now();

	const execOpts: ExecFileOptions = {
		cwd: opts.cwd,
		env: opts.env ? { ...process.env, ...opts.env } : undefined,
		timeout: opts.timeout ?? 120_000,
		maxBuffer: 10 * 1024 * 1024,
	};

	return new Promise((resolve, reject) => {
		cpExecFile(cmd, args, execOpts, (error, stdout, stderr) => {
			const result: ShellResult = {
				exitCode: typeof error?.code === "number" ? error.code : 0,
				stdout: typeof stdout === "string" ? stdout : "",
				stderr: typeof stderr === "string" ? stderr : "",
			};

			if (error && result.exitCode === 0) {
				result.exitCode = 1;
			}

			const durationMs = Math.round(performance.now() - t0);
			log.debug({ cmd, args, exitCode: result.exitCode, durationMs }, "shell complete");

			if (error && !opts.allowFailure) {
				reject(
					Object.assign(new Error(`Command failed: ${display}\n${result.stderr}`), {
						result,
					}),
				);
			} else {
				resolve(result);
			}
		});
	});
}

export async function shellOk(cmd: string, args: string[], opts?: ShellOpts): Promise<boolean> {
	const result = await shell(cmd, args, { ...opts, allowFailure: true, silent: true });
	return result.exitCode === 0;
}
