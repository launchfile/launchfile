/**
 * The D-58 `--url` channel at the command layer (#295): the operator's
 * publication URL reaches either provider's `appUrl` option untouched, and a
 * refused value reaches the operator as a message rather than a stack.
 *
 * Directories are injected temp paths — nothing touches the real
 * ~/.launchfile and nothing talks to docker.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerUpOpts, DockerUpResult } from "@launchfile/docker";
import { InvalidAppUrlError } from "@launchfile/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleUp } from "../commands/up.js";

let indexDir: string;
let recordDir: string;
let projectDir: string;

let output: string[];
let restore: (() => void) | null = null;

beforeEach(async () => {
	indexDir = await mkdtemp(join(tmpdir(), "lf-url-index-"));
	recordDir = await mkdtemp(join(tmpdir(), "lf-url-records-"));
	projectDir = await mkdtemp(join(tmpdir(), "lf-url-project-"));
	await writeFile(join(projectDir, "Launchfile"), "name: notes\n");

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
	return async (
		_source: string,
		opts: DockerUpOpts,
	): Promise<DockerUpResult> => {
		calls.push(opts);
		return { slug: "notes", appName: "notes", sourceType: "local" };
	};
}

describe("up --url reaches the docker provider (D-58)", () => {
	it("passes the value through untouched — normalization is the provider's", async () => {
		const calls: DockerUpOpts[] = [];
		await handleUp(
			projectDir,
			{ url: "https://notes.example.com/" },
			{ up: fakeUp(calls), indexDir, recordDir },
		);
		expect(calls).toHaveLength(1);
		// Trailing slash intact: `normalizeAppUrl` drops it, not the CLI.
		expect(calls[0]!.appUrl).toBe("https://notes.example.com/");
	});

	it("passes no URL when --url is absent, so a recorded one is preserved (D-49)", async () => {
		const calls: DockerUpOpts[] = [];
		await handleUp(projectDir, {}, { up: fakeUp(calls), indexDir, recordDir });
		expect(calls[0]!.appUrl).toBeUndefined();
	});

	it("carries a second, different URL through so the provider can replace it", async () => {
		const calls: DockerUpOpts[] = [];
		const deps = { up: fakeUp(calls), indexDir, recordDir };
		await handleUp(projectDir, { url: "https://notes.example.com" }, deps);
		await handleUp(projectDir, {}, deps);
		await handleUp(projectDir, { url: "https://wiki.example.com" }, deps);
		expect(calls.map((c) => c.appUrl)).toEqual([
			"https://notes.example.com",
			undefined,
			"https://wiki.example.com",
		]);
	});
});

describe("up --url reaches the macOS provider (D-58)", () => {
	it("threads the value into the native provider's appUrl channel", async () => {
		const calls: { appUrl?: string }[] = [];
		await handleUp(
			projectDir,
			{ native: true, url: "https://notes.example.com" },
			{
				importMacos: async () =>
					({
						launchUp: async (opts: { appUrl?: string }) => {
							calls.push(opts);
						},
					}) as unknown as typeof import("@launchfile/macos-dev"),
				indexDir,
				recordDir,
			},
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.appUrl).toBe("https://notes.example.com");
	});
});

describe("a refused publication URL reaches the operator (D-58 rule 3)", () => {
	/**
	 * The provider refuses; the command prints the message and exits non-zero.
	 * Without the catch this lands as an unhandled rejection with a stack,
	 * burying the one instruction the operator needs.
	 */
	async function expectRefusalPrinted(
		flags: { native?: boolean; url: string },
		err: Error,
	): Promise<string> {
		const exit = process.exit;
		let exited: number | undefined;
		process.exit = (code?: number) => {
			exited = code;
			throw new Error("exited");
		};
		try {
			await expect(
				handleUp(projectDir, flags, {
					up: async () => {
						throw err;
					},
					importMacos: async () =>
						({
							launchUp: async () => {
								throw err;
							},
						}) as unknown as typeof import("@launchfile/macos-dev"),
					indexDir,
					recordDir,
				}),
			).rejects.toThrow("exited");
		} finally {
			process.exit = exit;
		}
		expect(exited).toBe(1);
		return output.join("\n");
	}

	it("prints the docker refusal with no stack", async () => {
		const printed = await expectRefusalPrinted(
			{ url: "notes.example.com" },
			new InvalidAppUrlError(
				"notes.example.com",
				"not a parseable absolute URL",
			),
		);
		expect(printed).toContain("Invalid appUrl");
		expect(printed).toContain("absolute http:// or https:// URL");
	});

	it("prints the macOS refusal with no stack", async () => {
		const printed = await expectRefusalPrinted(
			{ native: true, url: "ftp://notes.example.com" },
			new InvalidAppUrlError(
				"ftp://notes.example.com",
				'scheme "ftp" is not http or https',
			),
		);
		expect(printed).toContain("Invalid appUrl");
	});

	it("never echoes userinfo from the refused value (D-18)", async () => {
		const printed = await expectRefusalPrinted(
			{ url: "https://admin:hunter2@notes.example.com" },
			new InvalidAppUrlError(
				"https://admin:hunter2@notes.example.com",
				"userinfo is not allowed",
			),
		);
		expect(printed).not.toContain("hunter2");
		expect(printed).toContain("***@notes.example.com");
	});
});
