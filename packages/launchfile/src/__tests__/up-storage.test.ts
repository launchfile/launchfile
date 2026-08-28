/**
 * The D-50 `--storage` channel at the command layer (#281): the parsed
 * volume-to-path map reaches either provider as typed, and both providers'
 * rule-2 refusals reach the operator as a message rather than a stack.
 *
 * Directories are injected temp paths — nothing touches the real
 * ~/.launchfile and nothing talks to docker.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerUpOpts, DockerUpResult } from "@launchfile/docker";
import {
	MissingOperatorStoragePathError,
	UnboundOperatorStorageError,
} from "@launchfile/sdk";
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

describe("up --storage reaches the macOS provider (D-50)", () => {
	it("threads the volume-to-path map into the provider opts, keys as typed", async () => {
		const calls: { storage?: Record<string, string> }[] = [];
		await handleUp(
			projectDir,
			{ native: true, storage: { music: "/srv/music", "web.books": "/srv/books" } },
			{
				importMacos: async () =>
					({
						launchUp: async (opts: { storage?: Record<string, string> }) => {
							calls.push(opts);
						},
					}) as unknown as typeof import("@launchfile/macos-dev"),
				indexDir,
				recordDir,
			},
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.storage).toEqual({ music: "/srv/music", "web.books": "/srv/books" });
	});
});

describe("the macOS provider's D-50 refusals reach the operator (rule 2)", () => {
	/**
	 * The provider throws; the command prints the message and stops. Without
	 * the catch this lands as an unhandled rejection with a stack, burying the
	 * one instruction the operator needs.
	 */
	async function expectRefusalPrinted(err: Error): Promise<string> {
		const exit = process.exit;
		let exited: number | undefined;
		process.exit = (code?: number) => {
			exited = code;
			throw new Error("exited");
		};
		try {
			await expect(
				handleUp(
					projectDir,
					{ native: true },
					{
						importMacos: async () =>
							({
								launchUp: async () => {
									throw err;
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
		return output.join("\n");
	}

	it("prints an unbound-volume refusal with no stack", async () => {
		const printed = await expectRefusalPrinted(
			new UnboundOperatorStorageError([
				{ component: "default", volume: "music", flag: "--storage music=<path>" },
			]),
		);
		expect(printed).toContain("supply it with --storage music=<path>");
	});

	it("prints a missing-path refusal with no stack", async () => {
		const printed = await expectRefusalPrinted(
			new MissingOperatorStoragePathError([
				{
					component: "default",
					volume: "music",
					key: "music",
					hostPath: "/srv/gone",
					containerPath: "/music",
				},
			]),
		);
		expect(printed).toContain("does not exist or is not readable");
	});
});
