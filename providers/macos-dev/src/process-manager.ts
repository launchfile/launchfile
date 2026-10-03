/**
 * Lightweight process manager for multi-component Launchfile apps.
 *
 * Handles topological startup ordering, log multiplexing,
 * health check waits, and graceful shutdown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, fchmodSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedHealth, NormalizedDependsOnEntry } from "@launchfile/sdk";
import { describeHealthCheck, healthBudgetMs, healthCheckNeedsPort, waitForHealthy } from "./health.js";
import { redactSecrets } from "./redact.js";

/**
 * How long a component gets to report healthy before `up` fails. A
 * provider-side budget: SPEC.md § Failure semantics binds the disposition of
 * the failure, not the number of seconds (P-11). Documented in CLAUDE.md as
 * PROVIDERS.md §10 rule 10 requires.
 */
export const HEALTH_TIMEOUT_MS = 60_000;

/**
 * How long a component that declares no `health:` is watched after spawn
 * before `up` counts it as up. A process that exits non-zero inside the window
 * has not come up (SPEC.md § Failure semantics, run slot); one that outlives
 * it is running as far as this provider can tell without a check. A component
 * with `health:` is watched for its whole health budget instead. The length
 * is a provider-side default (P-11), documented in CLAUDE.md as PROVIDERS.md
 * §10 rule 10 requires.
 */
export const EXIT_WATCH_MS = 2_000;

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
 * A component's process exited non-zero (or on a signal) before `startAll`
 * resolved, so the run slot failed: the component did not come up (SPEC.md
 * § Failure semantics). `launchUp` tags it with the `run` phase.
 */
export class ComponentExitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ComponentExitError";
	}
}

/** One component that exited before it came up, and how. */
export interface ExitedComponent {
	name: string;
	/** `exit code N`, or `signal SIG…` when the process died to one. */
	exit: string;
}

/** What an exit failure says: every exited component, named with its exit. */
export function exitFailureMessage(exited: ReadonlyArray<ExitedComponent>): string {
	const named = exited.map((e) => `${e.name} (${e.exit})`).join(", ");
	return `component(s) exited before coming up: ${named}`;
}

/** How a process ended: the code it returned, or the signal that took it. */
interface ProcessExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/** A non-zero exit or a signal death. Exit 0 is a process that chose to stop. */
function exitIsFailure(exit: ProcessExit): boolean {
	return exit.code !== 0;
}

function describeExit(exit: ProcessExit): string {
	return exit.code === null ? `signal ${exit.signal}` : `exit code ${exit.code}`;
}

/** One component the health gate gave up on: the probe asked and the window it got. */
export interface StuckComponent {
	name: string;
	check: string;
	budgetMs: number;
}

/**
 * What a health-gate failure says. Every stuck component is named with the
 * probe that was asked of it and the budget it actually got — budgets differ
 * per component once a file declares `retries` — so "did not become healthy"
 * is actionable.
 */
export function healthFailureMessage(stuck: ReadonlyArray<StuckComponent>): string {
	const named = stuck.map((s) => `${s.name} (${s.check}) within ${s.budgetMs / 1000}s`).join(", ");
	return `component(s) did not become healthy: ${named}`;
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

const TAIL_INTERVAL_MS = 200;

/**
 * Prints a component's log file as it grows. The component writes the file
 * itself; this only reads what it appends, so the console view holds nothing
 * the writer depends on. Polled, from the size the file had at `start`.
 */
class LogTail {
	private offset = 0;
	private partial = "";
	private timer?: NodeJS.Timeout;

	constructor(
		private readonly path: string,
		private readonly onLine: (line: string) => void,
	) {}

	start(): void {
		this.offset = this.size();
		this.timer = setInterval(() => this.drain(), TAIL_INTERVAL_MS);
		// The child handle keeps the session alive; the tail never should.
		this.timer.unref();
	}

	/** Print the rest of the file and stop polling. */
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.drain();
		if (this.partial) {
			this.onLine(this.partial);
			this.partial = "";
		}
	}

	private size(): number {
		try {
			return statSync(this.path).size;
		} catch {
			return 0;
		}
	}

	private drain(): void {
		const size = this.size();
		if (size <= this.offset) return;
		const buf = Buffer.alloc(size - this.offset);
		const fd = openSync(this.path, "r");
		try {
			const read = readSync(fd, buf, 0, buf.length, this.offset);
			this.offset += read;
			this.partial += buf.subarray(0, read).toString();
		} finally {
			closeSync(fd);
		}
		const lines = this.partial.split("\n");
		this.partial = lines.pop() ?? "";
		for (const line of lines) {
			if (line) this.onLine(line);
		}
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
	/** Aborted the moment the process exits, so a health poll can stop early. */
	exited?: AbortController;
	/** Set by the exit handler; absent while the process is alive. */
	exit?: ProcessExit;
	/** Set once the declared check passed. The exit handler overwrites `status`, so this is what remembers the component came up. */
	healthPassed?: boolean;
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
	private exitWatchMs: number;

	constructor(projectDir: string, opts: { healthTimeoutMs?: number; exitWatchMs?: number } = {}) {
		this.logDir = join(projectDir, ".launchfile", "logs");
		this.healthTimeoutMs = opts.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
		this.exitWatchMs = opts.exitWatchMs ?? EXIT_WATCH_MS;
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
	 * every component came up: one that declares `health:` must pass its check,
	 * and none may exit non-zero before this resolves.
	 *
	 * SPEC.md § Failure semantics: a component that never becomes healthy, or
	 * whose run slot fails, FAILS THE INVOCATION. The rejection names each
	 * exited component with its exit code, or each stuck component with the
	 * probe it was asked. A component without `health:` is watched until
	 * `EXIT_WATCH_MS` after the last spawn; one with `health:` for its whole budget. An
	 * exit found anywhere in that time wins over a stuck check, since it is
	 * terminal. Processes that did start are left running and stay registered,
	 * so the caller can record their pids for `status`/`logs`/`down`.
	 */
	async startAll(): Promise<void> {
		const batches = this.topologicalSort();

		for (const batch of batches) {
			// Start all processes in this batch concurrently
			await Promise.all(batch.map((name) => this.startOne(name)));
		}

		// A dependency gate above already verified some components; the sweep
		// covers the rest — including every component nothing depends on.
		const stuck: StuckComponent[] = [];
		await Promise.all(
			[...this.processes.values()].map(async (proc) => {
				const health = proc.health;
				if (!proc.process || proc.status === "healthy") return;
				if (!health) {
					await this.watchExit(proc);
					return;
				}
				// A poll that stopped because the process exited is an exit failure,
				// whatever the code; `exitedComponents` below names it.
				if (!(await this.pollHealthy(proc, health)) && !proc.exit) {
					stuck.push(this.stuck(proc, health));
				}
			}),
		);
		const exited = this.exitedComponents();
		if (exited.length > 0) {
			throw this.exitFailure(exitFailureMessage(exited));
		}
		if (stuck.length > 0) {
			throw this.healthFailure(healthFailureMessage(stuck));
		}
	}

	/** Resolves once the watch window closes or the process exits, whichever is first. */
	private watchExit(proc: ManagedProcess): Promise<void> {
		const exited = proc.exited;
		if (!exited || exited.signal.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			const done = (): void => {
				clearTimeout(timer);
				exited.signal.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, this.exitWatchMs);
			exited.signal.addEventListener("abort", done);
		});
	}

	/**
	 * Every spawned component whose process exited before it came up, in
	 * registration order. Without `health:`, exit 0 is a process that chose to
	 * stop. With `health:`, the component came up only once its check passed,
	 * so an exit before that is a failure whatever the code: the check it
	 * declared can no longer be answered.
	 */
	private exitedComponents(): ExitedComponent[] {
		const out: ExitedComponent[] = [];
		for (const proc of this.processes.values()) {
			if (!proc.exit) continue;
			if (exitIsFailure(proc.exit) || (proc.health && !proc.healthPassed)) {
				out.push(this.exited(proc));
			}
		}
		return out;
	}

	/** The failure-message entry for a component whose process exited. */
	private exited(proc: ManagedProcess): ExitedComponent {
		return {
			name: proc.name,
			exit: proc.exit ? describeExit(proc.exit) : "exited",
		};
	}

	/** The failure-message entry for a component whose check never passed. */
	private stuck(proc: ManagedProcess, health: NormalizedHealth): StuckComponent {
		return {
			name: proc.name,
			check: describeHealthCheck(health, proc.port),
			budgetMs: healthBudgetMs(health, this.healthTimeoutMs),
		};
	}

	/** Report a health-gate failure on stderr and build the error `up` rejects with. */
	private healthFailure(message: string): HealthGateError {
		console.error(`  ! ${message}`);
		console.error(
			"    Processes are left running: `launchfile status` lists them, .launchfile/logs/<component>.log has their output, `launchfile down` stops them.",
		);
		return new HealthGateError(message);
	}

	/**
	 * Report an exit failure on stderr and build the error `up` rejects with.
	 * Says what happened to the other components: the ones that did start are
	 * left running (#243), and the operator needs to know their ports are held.
	 */
	private exitFailure(message: string): ComponentExitError {
		console.error(`  ! ${message}`);
		console.error("    .launchfile/logs/<component>.log has the output of each.");
		const running = [...this.processes.values()]
			.filter((p) => p.process && !p.exit)
			.map((p) => p.name);
		if (running.length > 0) {
			console.error(
				`    Still running: ${running.join(", ")} — \`launchfile status\` lists them, \`launchfile down\` stops them.`,
			);
		} else {
			console.error("    No component is left running.");
		}
		return new ComponentExitError(message);
	}

	/**
	 * Poll one component's declared check until it passes, the budget runs
	 * out, or its process exits. Throws when the check cannot run at all: a
	 * `path` check with no allocated port has nothing to poll, and treating
	 * that as healthy would be a silent pass of a check the file declared.
	 */
	private async pollHealthy(proc: ManagedProcess, health: NormalizedHealth): Promise<boolean> {
		if (healthCheckNeedsPort(health) && proc.port === undefined) {
			throw this.healthFailure(
				`component ${proc.name} declares a health check (${describeHealthCheck(health, undefined)}) but no port was allocated to poll`,
			);
		}
		// A command check never reads the port; 0 only fills the parameter.
		const budget = healthBudgetMs(health, this.healthTimeoutMs);
		const ok = await waitForHealthy(proc.name, health, proc.port ?? 0, budget, proc.exited?.signal);
		if (ok) {
			proc.status = "healthy";
			proc.healthPassed = true;
		}
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
					// A dependency that exited cannot become healthy; name the exit,
					// not the check it can no longer answer.
					if (depProc.exit) {
						const message = exitFailureMessage([this.exited(depProc)]);
						throw this.exitFailure(`${message}; ${name} was not started`);
					}
					const message = healthFailureMessage([this.stuck(depProc, depProc.health)]);
					throw this.healthFailure(`${message}; ${name} was not started`);
				}
			}
			// For "started" condition, the process is already spawned by the time we get here
		}

		proc.status = "starting";
		console.log(`  [${name}] Starting: ${redactSecrets(proc.command)}`);

		const colorIdx = [...this.processes.keys()].indexOf(name) % COLORS.length;
		const color = COLORS[colorIdx]!;
		const maxNameLen = Math.max(...[...this.processes.keys()].map((n) => n.length));
		const paddedName = name.padEnd(maxNameLen);

		// The child writes its stdout and stderr straight to its log file. A pipe
		// held by this process would die with it, and a component left running
		// after `up` fails (SPEC.md § Failure semantics) must survive its next
		// write. The console view is a tail of that file.
		const logPath = join(this.logDir, `${name}.log`);
		const tail = new LogTail(logPath, (line) => {
			process.stdout.write(`${color}[${paddedName}]${RESET} ${line}\n`);
		});
		tail.start();

		// The log holds the component's raw output, which can include a secret an
		// app prints on first boot. The open mode covers a new file only, so a log
		// left by an earlier run is tightened too.
		const logFd = openSync(logPath, "a", 0o600);
		try {
			fchmodSync(logFd, 0o600);
			// `detached: true` makes the child the leader of a new process group
			// (pgid === pid). That lets `launch down` signal the whole group later via
			// a negative pid, killing the app AND any children it spawned — matching
			// the foreground SIGINT behavior across sessions. We still keep the handle
			// so the foreground session can kill it directly on Ctrl+C.
			proc.process = spawn("sh", ["-c", proc.command], {
				env: { ...process.env, ...proc.env },
				cwd: proc.cwd,
				stdio: ["ignore", logFd, logFd],
				detached: true,
			});
		} finally {
			// The child holds its own copy of the descriptor.
			closeSync(logFd);
		}
		if (proc.process.pid !== undefined) {
			proc.startedAt = new Date().toISOString();
		}

		const exited = new AbortController();
		proc.exited = exited;
		proc.process.on("exit", (code, signal) => {
			proc.exit = { code, signal };
			proc.status = code === 0 ? "stopped" : "failed";
			tail.stop();
			console.log(
				`${color}[${paddedName}]${RESET} Process exited (${describeExit(proc.exit)})`,
			);
			exited.abort();
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
			// A process that already exited fires no second `exit`; waiting on
			// one would hang shutdown.
			if (!proc.process || proc.exit) {
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
