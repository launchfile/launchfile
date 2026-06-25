/**
 * Cross-session app-process termination for `launch down`.
 *
 * The foreground `launch up` session kills its children directly via the
 * ProcessManager on Ctrl+C. But `launch down` may run from a *different* shell
 * (or after the up-session has exited), so it has no live ChildProcess handles —
 * only the pids recorded in `.launchfile/state.json`. This module signals those
 * recorded process groups, with liveness + identity checks to avoid killing an
 * unrelated process that happens to have inherited a recycled pid.
 *
 * ## pid-reuse identity guarantee (read this before trusting the kill)
 *
 * macOS recycles pids. A pid we recorded at `up` time may, by `down` time,
 * belong to a completely unrelated process. Before sending any signal we:
 *
 *   1. **Liveness** — `process.kill(pid, 0)` throws ESRCH if no such process
 *      exists. If it's dead, we skip (already stopped).
 *   2. **Identity** — we compare the recorded spawn time against the live
 *      process's actual start time via `ps -o lstart= -p <pid>`. If the live
 *      process started meaningfully later than we recorded, the pid was
 *      recycled and we REFUSE to signal it.
 *
 * This is a best-effort guarantee, not a cryptographic one. Its honest limits:
 *   - `ps lstart` has ~1s resolution, so we allow a small tolerance window. A
 *     recycled process that started within that window of the original spawn
 *     could theoretically slip through — vanishingly unlikely in practice.
 *   - If `ps` is unavailable/fails, we fall back to liveness-only and signal
 *     conservatively ONLY the process group (never a bare pid), accepting the
 *     small residual risk rather than orphaning the user's processes forever.
 *   - We signal the process GROUP (negative pgid) to also reap children the app
 *     spawned, matching the foreground SIGINT behavior. A recycled *group*
 *     leader is the residual risk the start-time check exists to close.
 */

import { execFile } from "node:child_process";

/** Signal-sending surface, injectable so tests never touch real processes. */
export interface SignalFns {
	/**
	 * Mirror of `process.kill`. Sending signal `0` performs a liveness probe
	 * (throws ESRCH if the target does not exist). A negative pid targets a
	 * process group.
	 */
	kill: (pid: number, signal: NodeJS.Signals | 0) => void;
	/**
	 * Returns the live process's start time (epoch ms) for `pid`, or null if the
	 * process is gone or the start time can't be determined.
	 */
	startTime: (pid: number) => Promise<number | null>;
}

/** Outcome of attempting to stop one recorded process, for logging/tests. */
export type StopOutcome =
	| { component: string; result: "stopped" }
	| { component: string; result: "already-dead" }
	| { component: string; result: "identity-mismatch" }
	| { component: string; result: "error"; error: string };

/** A short-lived recorded process, structurally matching ProcessState. */
export interface RecordedProcess {
	pid: number;
	pgid: number;
	startedAt: string;
	command: string;
}

/**
 * Identity tolerance: how much later than `startedAt` a live process may report
 * having started before we treat it as a recycled pid. `ps lstart` rounds to
 * whole seconds and there's scheduling slop between our `Date.now()` snapshot
 * and the kernel's recorded start, so we allow a few seconds of forward drift.
 */
const START_TIME_TOLERANCE_MS = 3000;

/** Default real implementation backed by `process.kill` and `ps`. */
export const realSignalFns: SignalFns = {
	kill: (pid, signal) => {
		process.kill(pid, signal);
	},
	startTime: (pid) => queryStartTime(pid),
};

/**
 * Query a process's start time via `ps -o lstart= -p <pid>` using array args
 * (no shell, no interpolation). Returns epoch ms, or null on any failure.
 */
function queryStartTime(pid: number): Promise<number | null> {
	return new Promise((resolve) => {
		execFile("ps", ["-o", "lstart=", "-p", String(pid)], (error, stdout) => {
			if (error) {
				resolve(null);
				return;
			}
			const text = stdout.trim();
			if (!text) {
				resolve(null);
				return;
			}
			const parsed = Date.parse(text);
			resolve(Number.isNaN(parsed) ? null : parsed);
		});
	});
}

/**
 * Verify a recorded process is still the one we started.
 *
 * Returns:
 *   - "alive-verified": process exists AND start time is consistent → safe to signal
 *   - "alive-unverified": process exists but start time couldn't be read → signal group only, cautiously
 *   - "dead": no such process (ESRCH) → already stopped, skip
 *   - "mismatch": process exists but started too late → recycled pid, DO NOT signal
 */
export async function checkIdentity(
	rec: RecordedProcess,
	fns: SignalFns,
): Promise<"alive-verified" | "alive-unverified" | "dead" | "mismatch"> {
	// Liveness probe.
	try {
		fns.kill(rec.pid, 0);
	} catch (err) {
		if (isErrno(err) && err.code === "ESRCH") return "dead";
		// EPERM means it exists but we can't signal it — treat as alive-unverified.
		if (isErrno(err) && err.code === "EPERM") return "alive-unverified";
		return "dead";
	}

	const liveStart = await fns.startTime(rec.pid);
	if (liveStart === null) return "alive-unverified";

	const recordedStart = Date.parse(rec.startedAt);
	if (Number.isNaN(recordedStart)) return "alive-unverified";

	// If the live process started meaningfully *after* we recorded the spawn,
	// the original exited and the pid was recycled. Refuse to signal it.
	if (liveStart > recordedStart + START_TIME_TOLERANCE_MS) return "mismatch";

	return "alive-verified";
}

/**
 * Stop one recorded process: graceful SIGTERM to the group, then escalate to
 * SIGKILL after `graceMs` if it's still alive. Always targets the process GROUP
 * (negative pgid) so child processes the app spawned die too.
 */
export async function stopProcess(
	component: string,
	rec: RecordedProcess,
	fns: SignalFns,
	opts: { graceMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<StopOutcome> {
	const graceMs = opts.graceMs ?? 5000;
	const sleep =
		opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	const identity = await checkIdentity(rec, fns);
	if (identity === "dead") return { component, result: "already-dead" };
	if (identity === "mismatch")
		return { component, result: "identity-mismatch" };

	// Target the process group. pgid is the leader pid because we spawned detached.
	const groupTarget = -rec.pgid;

	try {
		fns.kill(groupTarget, "SIGTERM");
	} catch (err) {
		if (isErrno(err) && err.code === "ESRCH")
			return { component, result: "already-dead" };
		return { component, result: "error", error: errMessage(err) };
	}

	// Wait for graceful exit, then escalate if the leader is still alive.
	await sleep(graceMs);

	let stillAlive = true;
	try {
		fns.kill(rec.pid, 0);
	} catch {
		stillAlive = false;
	}

	if (stillAlive) {
		try {
			fns.kill(groupTarget, "SIGKILL");
		} catch (err) {
			if (!(isErrno(err) && err.code === "ESRCH")) {
				return { component, result: "error", error: errMessage(err) };
			}
		}
	}

	return { component, result: "stopped" };
}

/**
 * Stop every recorded process. Pure orchestration over `stopProcess`; returns
 * one outcome per component so the caller can report and tests can assert.
 */
export async function stopRecordedProcesses(
	processes: Record<string, RecordedProcess>,
	fns: SignalFns = realSignalFns,
	opts: { graceMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<StopOutcome[]> {
	const outcomes: StopOutcome[] = [];
	for (const [component, rec] of Object.entries(processes)) {
		outcomes.push(await stopProcess(component, rec, fns, opts));
	}
	return outcomes;
}

interface ErrnoException {
	code?: string;
}

function isErrno(err: unknown): err is ErrnoException {
	return typeof err === "object" && err !== null && "code" in err;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
