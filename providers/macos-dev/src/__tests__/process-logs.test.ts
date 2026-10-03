/**
 * A component's output goes to `.launchfile/logs/<name>.log` by the
 * component's own hand, not through a pipe the `up` session holds. That is
 * what lets a process the health gate left running (SPEC.md § Failure
 * semantics, issue #376) outlive the session: a pipe dies with its reader,
 * and a server that logs each request would die on its first write after
 * `up` exited.
 *
 * The survival case runs the real `ProcessManager` in a throwaway `bun`
 * session that exits right after `startAll`, then watches the component keep
 * writing from the outside.
 */

import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessManager } from "../process-manager.js";

const PROCESS_MANAGER = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"process-manager.ts",
);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(50);
	}
	return predicate();
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

describe("component logs", () => {
	let projectDir: string;
	let pm: ProcessManager;
	let strayPid: number | undefined;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "launchfile-logs-"));
		pm = new ProcessManager(projectDir);
	});

	afterEach(async () => {
		await pm.stopAll();
		if (strayPid !== undefined) killGroup(strayPid);
		strayPid = undefined;
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("lands stdout and stderr in the component's log file as the process writes them", async () => {
		pm.register("web", {
			command: "echo first; echo oops >&2; sleep 0.3; echo second; sleep 30",
			env: {},
			cwd: projectDir,
		});
		await pm.startAll();

		const log = join(projectDir, ".launchfile", "logs", "web.log");
		expect(
			await waitFor(
				() => existsSync(log) && readFileSync(log, "utf8").includes("second"),
				3000,
			),
		).toBe(true);
		expect(readFileSync(log, "utf8")).toBe("first\noops\nsecond\n");
	});

	it("creates the component's log file readable by its owner only", async () => {
		// A component's raw output can hold a secret it prints on first boot.
		// Under the default 022 umask an open without a mode gives 0o644.
		const previous = process.umask(0o022);
		try {
			pm.register("web", { command: "sleep 30", env: {}, cwd: projectDir });
			await pm.startAll();
		} finally {
			process.umask(previous);
		}

		const log = join(projectDir, ".launchfile", "logs", "web.log");
		expect(statSync(log).mode & 0o777).toBe(0o600);
	});

	it("tightens a log file an earlier run left readable by others", async () => {
		const logDir = join(projectDir, ".launchfile", "logs");
		mkdirSync(logDir, { recursive: true });
		const log = join(logDir, "web.log");
		writeFileSync(log, "earlier run\n");
		chmodSync(log, 0o644);

		pm.register("web", {
			command: "echo now; sleep 30",
			env: {},
			cwd: projectDir,
		});
		await pm.startAll();

		expect(statSync(log).mode & 0o777).toBe(0o600);
		expect(
			await waitFor(() => readFileSync(log, "utf8").includes("now"), 3000),
		).toBe(true);
		expect(readFileSync(log, "utf8")).toBe("earlier run\nnow\n");
	});

	it("keeps a component alive, and its log growing, after the session that started it has exited", async () => {
		const marker = join(projectDir, "survived");
		const pidFile = join(projectDir, "pid");
		const script = join(projectDir, "session.ts");
		writeFileSync(
			script,
			[
				`import { writeFileSync } from "node:fs";`,
				`import { ProcessManager } from ${JSON.stringify(PROCESS_MANAGER)};`,
				`const pm = new ProcessManager(${JSON.stringify(projectDir)});`,
				`pm.register("web", {`,
				`  command: ${JSON.stringify(`sleep 0.5; echo after-exit; echo still-here; touch "${marker}"; sleep 30`)},`,
				`  env: {},`,
				`  cwd: ${JSON.stringify(projectDir)},`,
				`});`,
				`await pm.startAll();`,
				`writeFileSync(${JSON.stringify(pidFile)}, String(pm.getRecordedProcesses().web?.pid));`,
				`process.exit(0);`,
			].join("\n"),
		);

		const session = spawn("bun", ["run", script], { stdio: "ignore" });
		const exitCode = await new Promise<number | null>((resolve) =>
			session.on("exit", resolve),
		);
		expect(exitCode).toBe(0);
		strayPid = Number(readFileSync(pidFile, "utf8"));
		expect(alive(strayPid)).toBe(true);

		// The component writes twice after its session is gone. With a pipe to
		// that session it would take EPIPE here; with the file it carries on.
		expect(await waitFor(() => existsSync(marker), 5000)).toBe(true);
		expect(alive(strayPid)).toBe(true);
		const log = readFileSync(
			join(projectDir, ".launchfile", "logs", "web.log"),
			"utf8",
		);
		expect(log).toBe("after-exit\nstill-here\n");
	});
});
