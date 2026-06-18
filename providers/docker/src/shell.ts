/**
 * Shell execution helper with timeout and structured results.
 */

import { execFile as cpExecFile, spawn, type ExecFileOptions } from "node:child_process";
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
					Object.assign(new Error(`Command failed: ${display}`), {
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

/**
 * Run a command with stdout/stderr streamed straight to the terminal.
 * For long-running commands (image builds) where buffered execFile output
 * would show nothing for minutes and can exceed maxBuffer.
 */
export async function shellStream(
	cmd: string,
	args: string[],
	opts: ShellOpts & { allowFailure?: boolean } = {},
): Promise<number> {
	const display = [cmd, ...args].join(" ");
	if (!opts.silent) {
		console.log(`  $ ${display}`);
	}

	const log = getLogger();
	log.debug({ cmd, args, cwd: opts.cwd }, "shell stream exec");
	const t0 = performance.now();

	return new Promise((resolvePromise, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: opts.env ? { ...process.env, ...opts.env } : undefined,
			stdio: ["ignore", "inherit", "inherit"],
		});

		const timer = opts.timeout
			? setTimeout(() => child.kill("SIGTERM"), opts.timeout)
			: undefined;

		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			reject(err);
		});

		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			const exitCode = code ?? 1;
			log.debug(
				{ cmd, args, exitCode, durationMs: Math.round(performance.now() - t0) },
				"shell stream complete",
			);
			if (exitCode !== 0 && !opts.allowFailure) {
				reject(new Error(`Command failed: ${display} (exit ${exitCode})`));
			} else {
				resolvePromise(exitCode);
			}
		});
	});
}
