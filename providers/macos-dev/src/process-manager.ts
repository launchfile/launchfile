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
import { describeHealthCheck, healthCheckNeedsPort, waitForHealthy } from "./health.js";
import { redactSecrets } from "./redact.js";

/**
 * How long a component gets to report healthy before `up` fails. A
 * provider-side budget: SPEC.md § Failure semantics binds the disposition of
 * the failure, not the number of seconds (P-11). Documented in CLAUDE.md as
 * PROVIDERS.md §10 rule 10 requires.
 */
export const HEALTH_TIMEOUT_MS = 60_000;

/**
 * A component's declared `health:` never passed, or could not be checked at all.
 * The invocation fails (SPEC.md § Failure semantics); `launchUp` tags it with
 * the `health` phase so the CLI records the deployment the processes belong to.
 */
export class HealthGateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HealthGateError";
	}
}

/**
 * What a health-gate failure says. Every stuck component is named with the
 * probe that was asked of it, so "did not become healthy" is actionable.
 */
export function healthFailureMessage(
	stuck: ReadonlyArray<{ name: string; check: string }>,
	budgetMs: number,
): string {
	const named = stuck.map((s) => `${s.name} (${s.check})`).join(", ");
	return `component(s) ${named} did not become healthy within ${budgetMs / 1000}s`;
}

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

/**
 * Signal a detached child's whole process group (negative pid). Falls back to
 * signaling just the child handle if the group signal fails (e.g. the group is
 * already gone). Best-effort: swallows ESRCH so shutdown stays idempotent.
 */
function killGroupOrSelf(
	proc: ChildProcess | undefined,
	pid: number | undefined,
	signal: NodeJS.Signals,
): void {
	if (pid !== undefined) {
		try {
			process.kill(-pid, signal);
			return;
		} catch {
			// Group gone or not a group leader — fall through to handle kill.
		}
	}
	try {
		proc?.kill(signal);
	} catch {
		// Already exited.
	}
}

interface ManagedProcess {
	name: string;
	command: string;
	env: Record<string, string>;
	cwd: string;
	dependsOn: NormalizedDependsOnEntry[];
	health?: NormalizedHealth;
	port?: number;
	process?: ChildProcess;
	/** ISO timestamp captured right after a successful spawn (for pid identity). */
	startedAt?: string;
	status: "pending" | "starting" | "running" | "healthy" | "failed" | "stopped";
}

/** A spawned component process recorded for cross-session shutdown. */
export interface RecordedProcessInfo {
	pid: number;
	pgid: number;
	startedAt: string;
	command: string;
}

export class ProcessManager {
	private processes = new Map<string, ManagedProcess>();
	private logDir: string;
	private healthTimeoutMs: number;

	constructor(projectDir: string, opts: { healthTimeoutMs?: number } = {}) {
		this.logDir = join(projectDir, ".launchfile", "logs");
		this.healthTimeoutMs = opts.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
		// Security: restrict permissions — logs may contain sensitive output
		mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
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
	 * Start all registered processes respecting dependency order, then verify
	 * every component that declares `health:` actually became healthy.
	 *
	 * SPEC.md § Failure semantics: a component that never becomes healthy
	 * FAILS THE INVOCATION. The rejection names each stuck component and the
	 * probe it was asked. Processes that did start are left running and stay
	 * registered, so the caller can record their pids for `status`/`logs`/`down`.
	 */
	async startAll(): Promise<void> {
		const batches = this.topologicalSort();

		for (const batch of batches) {
			// Start all processes in this batch concurrently
			await Promise.all(batch.map((name) => this.startOne(name)));
		}

		// A dependency gate above already verified some components; the sweep
		// covers the rest — including every component nothing depends on.
		const stuck: Array<{ name: string; check: string }> = [];
		await Promise.all(
			[...this.processes.values()].map(async (proc) => {
				const health = proc.health;
				if (!health || !proc.process || proc.status === "healthy") return;
				if (!(await this.pollHealthy(proc, health))) {
					stuck.push({ name: proc.name, check: describeHealthCheck(health, proc.port) });
				}
			}),
		);
		if (stuck.length > 0) {
			throw this.healthFailure(healthFailureMessage(stuck, this.healthTimeoutMs));
		}
	}

	/** Report a health-gate failure on stderr and build the error `up` rejects with. */
	private healthFailure(message: string): HealthGateError {
		console.error(`  ! ${message}`);
		console.error("    Processes are left running. Inspect them with: launchfile status / launchfile logs");
		return new HealthGateError(message);
	}

	/**
	 * Poll one component's declared check until it passes or the budget runs
	 * out. Throws when the check cannot run at all: a `path` check with no
	 * allocated port has nothing to poll, and treating that as healthy would be
	 * a silent pass of a check the file declared.
	 */
	private async pollHealthy(proc: ManagedProcess, health: NormalizedHealth): Promise<boolean> {
		if (healthCheckNeedsPort(health) && proc.port === undefined) {
			throw this.healthFailure(
				`component ${proc.name} declares a health check (${describeHealthCheck(health, undefined)}) but no port was allocated to poll`,
			);
		}
		// A command check never reads the port; 0 only fills the parameter.
		const ok = await waitForHealthy(proc.name, health, proc.port ?? 0, this.healthTimeoutMs);
		if (ok) proc.status = "healthy";
		return ok;
	}

	private async startOne(name: string): Promise<void> {
		const proc = this.processes.get(name);
		if (!proc) throw new Error(`Unknown component: ${name}`);

		// Wait for dependencies. A `condition: healthy` gate fails closed: the
		// dependent never starts when the dependency cannot be verified, and the
		// whole invocation fails — the same answer compose gives `service_healthy`.
		for (const dep of proc.dependsOn) {
			const depProc = this.processes.get(dep.component);
			if (!depProc) continue;

			if (dep.condition === "healthy") {
				console.log(`  [${name}] Waiting for ${dep.component} to be healthy...`);
				if (!depProc.health) {
					throw this.healthFailure(
						`component ${name} depends on ${dep.component} with condition: healthy, but ${dep.component} declares no health check`,
					);
				}
				if (depProc.status !== "healthy" && !(await this.pollHealthy(depProc, depProc.health))) {
					const message = healthFailureMessage(
						[{ name: dep.component, check: describeHealthCheck(depProc.health, depProc.port) }],
						this.healthTimeoutMs,
					);
					throw this.healthFailure(`${message}; ${name} was not started`);
				}
			}
			// For "started" condition, the process is already spawned by the time we get here
		}

		proc.status = "starting";
		console.log(`  [${name}] Starting: ${redactSecrets(proc.command)}`);

		const logFile = createWriteStream(join(this.logDir, `${name}.log`), { flags: "a" });
		const colorIdx = [...this.processes.keys()].indexOf(name) % COLORS.length;
		const color = COLORS[colorIdx]!;
		const maxNameLen = Math.max(...[...this.processes.keys()].map((n) => n.length));
		const paddedName = name.padEnd(maxNameLen);

		// `detached: true` makes the child the leader of a new process group
		// (pgid === pid). That lets `launch down` signal the whole group later via
		// a negative pid, killing the app AND any children it spawned — matching
		// the foreground SIGINT behavior across sessions. We still keep the handle
		// so the foreground session can kill it directly on Ctrl+C.
		proc.process = spawn("sh", ["-c", proc.command], {
			env: { ...process.env, ...proc.env },
			cwd: proc.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		if (proc.process.pid !== undefined) {
			proc.startedAt = new Date().toISOString();
		}

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

			const pid = proc.process.pid;

			const timeout = setTimeout(() => {
				// Escalate to the whole group so stray children die too.
				killGroupOrSelf(proc.process, pid, "SIGKILL");
			}, 10_000);

			proc.process.once("exit", () => {
				clearTimeout(timeout);
				proc.status = "stopped";
				resolve();
			});

			// Children are spawned detached (own process group), so signal the
			// group (negative pid) to reap any grandchildren too.
			killGroupOrSelf(proc.process, pid, "SIGTERM");
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

	/**
	 * Snapshot the live, spawned processes for persistence to state.json.
	 * Only includes components that actually spawned (have a pid). Because we
	 * spawn detached, the child is its own group leader, so pgid === pid.
	 */
	getRecordedProcesses(): Record<string, RecordedProcessInfo> {
		const out: Record<string, RecordedProcessInfo> = {};
		for (const [name, proc] of this.processes) {
			const pid = proc.process?.pid;
			if (pid === undefined || proc.startedAt === undefined) continue;
			out[name] = {
				pid,
				pgid: pid,
				startedAt: proc.startedAt,
				command: proc.command,
			};
		}
		return out;
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
