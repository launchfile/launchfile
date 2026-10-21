/**
 * A child's `exit` event fires once and is not replayed for a listener
 * attached later. `startOne` awaits the log descriptor's close after spawning,
 * so the listener must already be on the child by then: a component that
 * exits during that await (a fast `exit 1` on a loaded CI runner) was
 * otherwise never seen. `startAll` resolved once the watch window closed, as
 * if the component were up, and `stopAll` waited on an exit that had already
 * happened.
 *
 * The close is held open here until well after the child has exited, which
 * makes the race the loaded runner hit happen on every run.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CLOSE_DELAY_MS = 1_000;

vi.mock("../safe-path.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../safe-path.js")>();
	return {
		...actual,
		openConfinedFile: async (
			...args: Parameters<typeof actual.openConfinedFile>
		): Promise<FileHandle> => {
			const handle = await actual.openConfinedFile(...args);
			const close = handle.close.bind(handle);
			handle.close = async () => {
				await new Promise((resolve) => setTimeout(resolve, CLOSE_DELAY_MS));
				await close();
			};
			return handle;
		},
	};
});

const { ComponentExitError, exitFailureMessage, ProcessManager } = await import(
	"../process-manager.js"
);

describe("ProcessManager sees an exit that happens while the log closes", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "launchfile-exit-race-"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("fails startAll with the exit code, and stopAll returns at once", async () => {
		const pm = new ProcessManager(projectDir, { exitWatchMs: 2_000 });
		pm.register("web", { command: "exit 3", env: {}, cwd: projectDir });

		const err = await pm.startAll().catch((e: unknown) => e as Error);
		expect(err).toBeInstanceOf(ComponentExitError);
		expect((err as Error).message).toBe(
			exitFailureMessage([{ name: "web", exit: "exit code 3" }]),
		);
		expect(pm.getStatus().find((s) => s.name === "web")?.status).toBe("failed");

		const started = Date.now();
		await pm.stopAll();
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("names a signal death that happens while the log closes", async () => {
		const pm = new ProcessManager(projectDir, { exitWatchMs: 2_000 });
		pm.register("web", { command: 'kill -9 "$$"', env: {}, cwd: projectDir });

		await expect(pm.startAll()).rejects.toThrow(
			exitFailureMessage([{ name: "web", exit: "signal SIGKILL" }]),
		);
		await pm.stopAll();
	});
});
