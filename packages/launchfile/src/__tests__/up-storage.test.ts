/**
 * The D-50 `--storage` channel at the command layer (#281): the parsed
 * volume-to-path map reaches the docker provider as typed, and the macOS
 * provider refuses the flag instead of silently dropping the operator's
 * paths and provisioning provider-owned storage where their content belongs.
 *
 * Directories are injected temp paths — nothing touches the real
 * ~/.launchfile and nothing talks to docker.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerUpOpts, DockerUpResult } from "@launchfile/docker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleUp } from "../commands/up.js";

let indexDir: string;
let recordDir: string;
let projectDir: string;

let output: string[];
let restore: (() => void) | null = null;

beforeEach(async () => {
	indexDir = await mkdtemp(join(tmpdir(), "lf-storage-index-"));
	recordDir = await mkdtemp(join(tmpdir(), "lf-storage-records-"));
	projectDir = await mkdtemp(join(tmpdir(), "lf-storage-project-"));
	await writeFile(join(projectDir, "Launchfile"), "name: stor\n");

	output = [];
	const log = console.log;
	const err = console.error;
	console.log = (...args: unknown[]) => output.push(args.join(" "));
	console.error = (...args: unknown[]) => output.push(args.join(" "));
	restore = () => {
		console.log = log;
		console.error = err;
	};
});

afterEach(() => {
	restore?.();
	restore = null;
});

function fakeUp(calls: DockerUpOpts[]) {
	return async (_source: string, opts: DockerUpOpts): Promise<DockerUpResult> => {
		calls.push(opts);
		return { slug: "stor", appName: "stor", sourceType: "local" };
	};
}

describe("up --storage reaches the docker provider (D-50)", () => {
	it("threads the volume-to-path map into the provider opts, keys as typed", async () => {
		const calls: DockerUpOpts[] = [];
		await handleUp(
			projectDir,
			{ storage: { music: "/srv/music", "web.books": "/srv/books" } },
			{ up: fakeUp(calls), indexDir, recordDir },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.storage).toEqual({ music: "/srv/music", "web.books": "/srv/books" });
	});

	it("passes no map when --storage is absent", async () => {
		const calls: DockerUpOpts[] = [];
		await handleUp(projectDir, {}, { up: fakeUp(calls), indexDir, recordDir });
		expect(calls[0]!.storage).toBeUndefined();
	});
});

describe("the macOS provider refuses --storage (D-50 silent-drop ban)", () => {
	it("errors clearly before anything launches", async () => {
		const exit = process.exit;
		let exited: number | undefined;
		let launched = false;
		process.exit = (code?: number) => {
			exited = code;
			throw new Error("exited");
		};
		try {
			await expect(
				handleUp(
					projectDir,
					{ native: true, storage: { music: "/srv/music" } },
					{
						importMacos: async () =>
							({
								launchUp: async () => {
									launched = true;
								},
							}) as unknown as typeof import("@launchfile/macos-dev"),
						indexDir,
						recordDir,
					},
				),
			).rejects.toThrow("exited");
		} finally {
			process.exit = exit;
		}

		expect(exited).toBe(1);
		expect(launched).toBe(false);
		expect(output.join("\n")).toContain(
			"--storage is not yet supported by the macOS native provider",
		);
	});
});
