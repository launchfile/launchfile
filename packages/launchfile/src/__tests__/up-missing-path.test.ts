/**
 * `up <path>` with a path that does not exist refuses before any provider
 * runs and writes no deployment index row. Directories are injected temp
 * paths; `docker: true` skips provider detection.
 */

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerUpOpts } from "@launchfile/docker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleUp } from "../commands/up.js";
import { loadIndex } from "../state/index.js";

let root: string;
let indexDir: string;
let recordDir: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "lf-missing-"));
	indexDir = join(root, "index");
	recordDir = join(root, "records");
	await Promise.all([mkdir(indexDir), mkdir(recordDir)]);
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`exit:${code}`);
	}) as never);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("up <path> where the path does not exist", () => {
	it("exits 1, never calls the provider, and writes no index row", async () => {
		const launches: DockerUpOpts[] = [];
		const up = async (_s: string, opts: DockerUpOpts): Promise<never> => {
			launches.push(opts);
			throw new Error("provider must not run");
		};
		await expect(
			handleUp(join(root, "does-not-exist"), { docker: true }, { up, indexDir, recordDir }),
		).rejects.toThrow("exit:1");
		expect(launches).toHaveLength(0);
		expect(Object.keys((await loadIndex(indexDir)).deployments)).toHaveLength(0);
	});

	it("exits 1 for --native too, before the provider is chosen", async () => {
		await expect(
			handleUp("./does-not-exist", { native: true }, { indexDir, recordDir }),
		).rejects.toThrow("exit:1");
		expect(Object.keys((await loadIndex(indexDir)).deployments)).toHaveLength(0);
	});
});
