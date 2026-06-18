import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	checkIdentity,
	type RecordedProcess,
	type SignalFns,
	stopProcess,
	stopRecordedProcesses,
} from "../process-stopper.js";

/** Build a SignalFns spy that records every signal sent, with no real effect. */
function fakeSignals(opts: {
	/** pids considered alive for the liveness probe (signal 0). */
	alive: Set<number>;
	/** start time (epoch ms) reported by `ps` per pid, or null. */
	startTimes?: Record<number, number | null>;
}): SignalFns & { sent: Array<{ pid: number; signal: NodeJS.Signals | 0 }> } {
	const sent: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
	return {
		sent,
		kill(pid, signal) {
			sent.push({ pid, signal });
			if (signal === 0) {
				// Liveness probe: throw ESRCH if the (positive) pid is not alive.
				if (!opts.alive.has(Math.abs(pid))) {
					throw Object.assign(new Error("no such process"), { code: "ESRCH" });
				}
			}
		},
		async startTime(pid) {
			return opts.startTimes?.[pid] ?? null;
		},
	};
}

const noSleep = async (): Promise<void> => {};

describe("checkIdentity", () => {
	it("reports dead for a pid that fails the liveness probe", async () => {
		const rec: RecordedProcess = {
			pid: 4242,
			pgid: 4242,
			startedAt: new Date().toISOString(),
			command: "sh -c 'sleep 1'",
		};
		const fns = fakeSignals({ alive: new Set() });
		expect(await checkIdentity(rec, fns)).toBe("dead");
	});

	it("verifies a live pid whose start time matches the record", async () => {
		const startedAt = new Date();
		const rec: RecordedProcess = {
			pid: 100,
			pgid: 100,
			startedAt: startedAt.toISOString(),
			command: "app",
		};
		const fns = fakeSignals({
			alive: new Set([100]),
			startTimes: { 100: startedAt.getTime() },
		});
		expect(await checkIdentity(rec, fns)).toBe("alive-verified");
	});

	it("flags identity mismatch when the live process started much later (recycled pid)", async () => {
		const recordedStart = new Date("2020-01-01T00:00:00.000Z");
		const rec: RecordedProcess = {
			pid: 100,
			pgid: 100,
			startedAt: recordedStart.toISOString(),
			command: "app",
		};
		// Live process started a full day later → pid was recycled.
		const fns = fakeSignals({
			alive: new Set([100]),
			startTimes: { 100: recordedStart.getTime() + 86_400_000 },
		});
		expect(await checkIdentity(rec, fns)).toBe("mismatch");
	});

	it("treats a missing start time as alive-unverified", async () => {
		const rec: RecordedProcess = {
			pid: 100,
			pgid: 100,
			startedAt: new Date().toISOString(),
			command: "app",
		};
		const fns = fakeSignals({
			alive: new Set([100]),
			startTimes: { 100: null },
		});
		expect(await checkIdentity(rec, fns)).toBe("alive-unverified");
	});
});

describe("stopProcess", () => {
	it("sends SIGTERM to the process GROUP (negative pgid), then no SIGKILL if it exits", async () => {
		const startedAt = new Date();
		const rec: RecordedProcess = {
			pid: 200,
			pgid: 200,
			startedAt: startedAt.toISOString(),
			command: "app",
		};
		// Mutable alive set: process exits during the grace window (custom sleep
		// removes it), so the post-grace liveness probe fails → no SIGKILL.
		const aliveSet = new Set([200]);
		const sent: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
		const fns: SignalFns = {
			kill(pid, signal) {
				sent.push({ pid, signal });
				if (signal === 0 && !aliveSet.has(Math.abs(pid))) {
					throw Object.assign(new Error("no such process"), { code: "ESRCH" });
				}
			},
			async startTime() {
				return startedAt.getTime();
			},
		};
		const sleep = async (): Promise<void> => {
			aliveSet.delete(200); // simulate graceful exit after SIGTERM
		};

		const outcome = await stopProcess("web", rec, fns, { graceMs: 0, sleep });

		expect(outcome).toEqual({ component: "web", result: "stopped" });
		// The kill signal must target the group (negative pgid), not the bare pid.
		expect(sent.find((s) => s.signal === "SIGTERM")).toEqual({
			pid: -200,
			signal: "SIGTERM",
		});
		expect(sent.some((s) => s.signal === "SIGKILL")).toBe(false);
	});

	it("escalates to SIGKILL on the group if still alive after the grace window", async () => {
		const startedAt = new Date();
		const rec: RecordedProcess = {
			pid: 300,
			pgid: 300,
			startedAt: startedAt.toISOString(),
			command: "app",
		};
		// Stays alive the whole time → escalation expected.
		const fns = fakeSignals({
			alive: new Set([300]),
			startTimes: { 300: startedAt.getTime() },
		});
		const outcome = await stopProcess("web", rec, fns, {
			graceMs: 0,
			sleep: noSleep,
		});

		expect(outcome.result).toBe("stopped");
		expect(fns.sent).toContainEqual({ pid: -300, signal: "SIGTERM" });
		expect(fns.sent).toContainEqual({ pid: -300, signal: "SIGKILL" });
	});

	it("does NOT signal a process that fails identity (recycled pid)", async () => {
		const recordedStart = new Date("2020-01-01T00:00:00.000Z");
		const rec: RecordedProcess = {
			pid: 400,
			pgid: 400,
			startedAt: recordedStart.toISOString(),
			command: "app",
		};
		const fns = fakeSignals({
			alive: new Set([400]),
			startTimes: { 400: recordedStart.getTime() + 86_400_000 },
		});
		const outcome = await stopProcess("web", rec, fns, {
			graceMs: 0,
			sleep: noSleep,
		});

		expect(outcome).toEqual({ component: "web", result: "identity-mismatch" });
		// Only the liveness probe (signal 0) may have been sent — never a real kill.
		expect(fns.sent.every((s) => s.signal === 0)).toBe(true);
	});

	it("reports already-dead and signals nothing for a dead pid", async () => {
		const rec: RecordedProcess = {
			pid: 500,
			pgid: 500,
			startedAt: new Date().toISOString(),
			command: "app",
		};
		const fns = fakeSignals({ alive: new Set() });
		const outcome = await stopProcess("web", rec, fns, {
			graceMs: 0,
			sleep: noSleep,
		});

		expect(outcome).toEqual({ component: "web", result: "already-dead" });
		// No SIGTERM/SIGKILL — only the failed liveness probe.
		expect(fns.sent.every((s) => s.signal === 0)).toBe(true);
	});
});

describe("stopRecordedProcesses", () => {
	it("returns one outcome per recorded component", async () => {
		const now = Date.now();
		const startedAt = new Date(now).toISOString();
		const fns = fakeSignals({
			alive: new Set([10, 20]),
			startTimes: { 10: now, 20: now },
		});
		const outcomes = await stopRecordedProcesses(
			{
				web: { pid: 10, pgid: 10, startedAt, command: "a" },
				worker: { pid: 20, pgid: 20, startedAt, command: "b" },
			},
			fns,
			{ graceMs: 0, sleep: noSleep },
		);
		expect(outcomes.map((o) => o.component).sort()).toEqual(["web", "worker"]);
		expect(outcomes.every((o) => o.result === "stopped")).toBe(true);
	});

	it("handles an empty processes map without throwing", async () => {
		const fns = fakeSignals({ alive: new Set() });
		expect(await stopRecordedProcesses({}, fns)).toEqual([]);
	});
});

describe("real liveness via process.kill semantics", () => {
	it("reports dead for a genuinely-exited child process", async () => {
		// Spawn a real short-lived process, let it exit, then assert our guard
		// (using the real liveness probe) reports it dead. No long-lived process,
		// no timing race — we await the actual 'exit' event.
		const child = spawn("true", [], { stdio: "ignore" });
		const pid = child.pid;
		if (pid === undefined) throw new Error("spawned child has no pid");
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));

		// Use the REAL kill (process.kill) for the liveness probe; inject a
		// startTime that can't matter because the process is already dead.
		const realLiveness: SignalFns = {
			kill: (p, signal) => {
				process.kill(p, signal);
			},
			async startTime() {
				return null;
			},
		};
		const rec: RecordedProcess = {
			pid,
			pgid: pid,
			startedAt: new Date().toISOString(),
			command: "true",
		};
		expect(await checkIdentity(rec, realLiveness)).toBe("dead");
	});
});
