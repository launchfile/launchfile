/**
 * Lightweight process manager for multi-component Launchfile apps.
 *
 * Handles topological startup ordering, log multiplexing,
 * health check waits, and graceful shutdown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedHealth, NormalizedDependsOnEntry } from "@launchfile/sdk";
import { waitForHealthy } from "./health.js";

// ANSI colors for log prefixing
const COLORS = [
	"\x1b[36m", // cyan
	"\x1b[33m", // yellow
	"\x1b[32m", // green
	"\x1b[35m", // magenta
	"\x1b[34m", // blue
	"\x1b[31m", // red
];
const RESET = "\x1b[0m";

interface ManagedProcess {
	name: string;
	command: string;
	env: Record<string, string>;
	cwd: string;
	dependsOn: NormalizedDependsOnEntry[];
	health?: NormalizedHealth;
	port?: number;
	process?: ChildProcess;
	status: "pending" | "starting" | "running" | "healthy" | "failed" | "stopped";
}

export class ProcessManager {
	private processes = new Map<string, ManagedProcess>();
	private logDir: string;

	constructor(projectDir: string) {
		this.logDir = join(projectDir, ".launchfile", "logs");
		mkdirSync(this.logDir, { recursive: true });
	}

	register(
		name: string,
		config: {
			command: string;
			env: Record<string, string>;
			cwd: string;
			dependsOn?: NormalizedDependsOnEntry[];
			health?: NormalizedHealth;
			port?: number;
		},
	): void {
		this.processes.set(name, {
			name,
			command: config.command,
			env: config.env,
			cwd: config.cwd,
			dependsOn: config.dependsOn ?? [],
			health: config.health,
			port: config.port,
			status: "pending",
		});
	}

	/**
	 * Start all registered processes respecting dependency order.
	 */
	async startAll(): Promise<void> {
		const batches = this.topologicalSort();

		for (const batch of batches) {
			// Start all processes in this batch concurrently
			await Promise.all(batch.map((name) => this.startOne(name)));
		}

		console.log("\n  All components started.");
	}

	private async startOne(name: string): Promise<void> {
		const proc = this.processes.get(name);
		if (!proc) throw new Error(`Unknown component: ${name}`);

		// Wait for dependencies
		for (const dep of proc.dependsOn) {
			const depProc = this.processes.get(dep.component);
			if (!depProc) continue;

			if (dep.condition === "healthy") {
				console.log(`  [${name}] Waiting for ${dep.component} to be healthy...`);
				if (depProc.health && depProc.port) {
					await waitForHealthy(dep.component, depProc.health, depProc.port);
				}
			}
			// For "started" condition, the process is already spawned by the time we get here
		}

		proc.status = "starting";
		console.log(`  [${name}] Starting: ${proc.command}`);

		const logFile = createWriteStream(join(this.logDir, `${name}.log`), { flags: "a" });
		const colorIdx = [...this.processes.keys()].indexOf(name) % COLORS.length;
		const color = COLORS[colorIdx]!;
		const maxNameLen = Math.max(...[...this.processes.keys()].map((n) => n.length));
		const paddedName = name.padEnd(maxNameLen);

		proc.process = spawn("sh", ["-c", proc.command], {
			env: { ...process.env, ...proc.env },
			cwd: proc.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		// Pipe stdout with prefix
		proc.process.stdout?.on("data", (data: Buffer) => {
			const lines = data.toString().split("\n");
			for (const line of lines) {
				if (line) {
					process.stdout.write(`${color}[${paddedName}]${RESET} ${line}\n`);
					logFile.write(`${new Date().toISOString()} ${line}\n`);
				}
			}
		});

		// Pipe stderr with prefix
		proc.process.stderr?.on("data", (data: Buffer) => {
			const lines = data.toString().split("\n");
			for (const line of lines) {
				if (line) {
					process.stderr.write(`${color}[${paddedName}]${RESET} \x1b[2m${line}${RESET}\n`);
					logFile.write(`${new Date().toISOString()} ERR ${line}\n`);
				}
			}
		});

		proc.process.on("exit", (code) => {
			proc.status = code === 0 ? "stopped" : "failed";
			console.log(
				`${color}[${paddedName}]${RESET} Process exited with code ${code}`,
			);
			logFile.end();
		});

		proc.status = "running";
	}

	/**
	 * Graceful shutdown in reverse dependency order.
	 */
	async stopAll(): Promise<void> {
		const batches = this.topologicalSort().reverse();

		for (const batch of batches) {
			await Promise.all(
				batch.map((name) => {
					const proc = this.processes.get(name);
					if (!proc?.process || proc.status === "stopped") return Promise.resolve();
					return this.stopOne(proc);
				}),
			);
		}
	}

	private stopOne(proc: ManagedProcess): Promise<void> {
		return new Promise((resolve) => {
			if (!proc.process) {
				resolve();
				return;
			}

			const timeout = setTimeout(() => {
				proc.process?.kill("SIGKILL");
			}, 10_000);

			proc.process.once("exit", () => {
				clearTimeout(timeout);
				proc.status = "stopped";
				resolve();
			});

			proc.process.kill("SIGTERM");
		});
	}

	/**
	 * Topological sort based on depends_on.
	 * Returns batches of component names that can start concurrently.
	 */
	private topologicalSort(): string[][] {
		const names = [...this.processes.keys()];
		const inDegree = new Map<string, number>();
		const dependents = new Map<string, string[]>();

		for (const name of names) {
			inDegree.set(name, 0);
			dependents.set(name, []);
		}

		for (const [name, proc] of this.processes) {
			for (const dep of proc.dependsOn) {
				if (this.processes.has(dep.component)) {
					inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
					dependents.get(dep.component)!.push(name);
				}
			}
		}

		const batches: string[][] = [];
		let remaining = new Set(names);

		while (remaining.size > 0) {
			const batch = [...remaining].filter((n) => (inDegree.get(n) ?? 0) === 0);
			if (batch.length === 0) {
				// Circular dependency — just add remaining
				batches.push([...remaining]);
				break;
			}
			batches.push(batch);
			for (const name of batch) {
				remaining.delete(name);
				for (const dependent of dependents.get(name) ?? []) {
					inDegree.set(dependent, (inDegree.get(dependent) ?? 0) - 1);
				}
			}
		}

		return batches;
	}

	/** Get status summary for all processes */
	getStatus(): Array<{ name: string; status: string; pid?: number; port?: number }> {
		return [...this.processes.entries()].map(([name, proc]) => ({
			name,
			status: proc.status,
			pid: proc.process?.pid,
			port: proc.port,
		}));
	}
}
