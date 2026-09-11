/**
 * `launchfile bootstrap --reveal` reaches both providers (#464, D-62). The
 * providers are injected and the index lives in a temp dir — nothing touches
 * the real ~/.launchfile and nothing talks to docker.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type DockerBootstrapOpts,
	handleBootstrap,
	type MacosBootstrapOpts,
} from "../commands/bootstrap.js";
import { type DeploymentEntry, saveIndex } from "../state/index.js";

let indexDir: string;
let recordDir: string;
let projectDir: string;
let exited: number | undefined;
let restore: () => void;

function entry(provider: "docker" | "macos"): DeploymentEntry {
	const now = new Date().toISOString();
	return {
		appName: "acme",
		provider,
		source: projectDir,
		sourceType: "local",
		slug: "acme",
		name: null,
		port: null,
		status: "up",
		createdAt: now,
		updatedAt: now,
	};
}

beforeEach(async () => {
	indexDir = await mkdtemp(join(tmpdir(), "lf-reveal-index-"));
	recordDir = await mkdtemp(join(tmpdir(), "lf-reveal-records-"));
	projectDir = await mkdtemp(join(tmpdir(), "lf-reveal-project-"));
	await writeFile(
		join(projectDir, "Launchfile"),
		"version: launch/v1\nname: acme\nimage: acme:1\ncommands:\n  start: serve\n  bootstrap: seed\n",
	);

	exited = undefined;
	const exit = process.exit;
	const log = console.log;
	const error = console.error;
	// The first exit code wins: the macos branch's catch re-exits with 1 when
	// the thrown stand-in for exit(0) reaches it.
	process.exit = ((code?: number) => {
		exited ??= code ?? 0;
		throw new Error("exited");
	}) as typeof process.exit;
	console.log = () => {};
	console.error = () => {};
	restore = () => {
		process.exit = exit;
		console.log = log;
		console.error = error;
	};
});

afterEach(async () => {
	restore();
	await rm(indexDir, { recursive: true, force: true });
	await rm(recordDir, { recursive: true, force: true });
	await rm(projectDir, { recursive: true, force: true });
});

describe("docker", () => {
	it.each([true, false, undefined])(
		"passes reveal=%s through unchanged",
		async (reveal) => {
			await saveIndex(
				{ version: 1, deployments: { d1: entry("docker") } },
				indexDir,
			);
			const calls: DockerBootstrapOpts[] = [];
			await expect(
				handleBootstrap(
					"d1",
					{ reveal },
					{
						indexDir,
						recordDir,
						dockerBootstrap: async (opts) => {
							calls.push(opts);
							return [];
						},
					},
				),
			).rejects.toThrow("exited");
			expect(calls).toHaveLength(1);
			expect(calls[0]?.reveal).toBe(reveal);
			expect(calls[0]?.slug).toBe("acme");
			expect(exited).toBe(0);
		},
	);
});

describe("macos", () => {
	it.each([true, false, undefined])(
		"passes reveal=%s through unchanged",
		async (reveal) => {
			await saveIndex(
				{ version: 1, deployments: { m1: entry("macos") } },
				indexDir,
			);
			const calls: MacosBootstrapOpts[] = [];
			await expect(
				handleBootstrap(
					"m1",
					{ reveal },
					{
						indexDir,
						recordDir,
						macosBootstrap: async (opts) => {
							calls.push(opts);
							return [{ ok: true }];
						},
					},
				),
			).rejects.toThrow("exited");
			expect(calls).toHaveLength(1);
			expect(calls[0]?.reveal).toBe(reveal);
			expect(calls[0]?.projectDir).toBe(projectDir);
			expect(exited).toBe(0);
		},
	);
});
