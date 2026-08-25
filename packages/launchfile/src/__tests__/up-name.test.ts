/**
 * Instance identity at the command layer (#240, D-59): `--name` reaches the
 * docker provider, the deployment index keys instances by the (source, name)
 * pair, and the macOS provider refuses the flag instead of silently running a
 * single unlabeled instance.
 *
 * Directories are injected temp paths — nothing touches the real ~/.launchfile
 * and nothing talks to docker.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerUpOpts, DockerUpResult } from "@launchfile/docker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleUp } from "../commands/up.js";
import { findBySource, loadIndex } from "../state/index.js";
import type { DeploymentIndex } from "../state/types.js";

let indexDir: string;
let recordDir: string;
let projectDir: string;

let output: string[];
let restore: (() => void) | null = null;

beforeEach(async () => {
	indexDir = await mkdtemp(join(tmpdir(), "lf-name-index-"));
	recordDir = await mkdtemp(join(tmpdir(), "lf-name-records-"));
	projectDir = await mkdtemp(join(tmpdir(), "lf-name-project-"));
	await writeFile(join(projectDir, "Launchfile"), "name: iso\n");

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

/** A fake provider that derives the effective slug the way dockerUp does. */
function fakeUp(calls: DockerUpOpts[]) {
	return async (_source: string, opts: DockerUpOpts): Promise<DockerUpResult> => {
		calls.push(opts);
		return {
			slug: opts.name ? `iso-${opts.name}` : "iso",
			appName: "iso",
			sourceType: "local",
		};
	};
}

async function index(): Promise<DeploymentIndex> {
	return loadIndex(indexDir);
}

describe("up --name reaches the docker provider", () => {
	it("threads the label into the provider opts", async () => {
		const calls: DockerUpOpts[] = [];
		await handleUp(projectDir, { name: "a" }, { up: fakeUp(calls), indexDir, recordDir });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("a");
	});

	it("passes no label when --name is absent", async () => {
		const calls: DockerUpOpts[] = [];
		await handleUp(projectDir, {}, { up: fakeUp(calls), indexDir, recordDir });
		expect(calls[0]!.name).toBeUndefined();
	});
});

describe("the deployment index keys instances by (source, name) (D-59)", () => {
	it("gives each label from one directory its own entry, plus the unnamed one", async () => {
		const deps = { up: fakeUp([]), indexDir, recordDir };
		await handleUp(projectDir, {}, deps);
		await handleUp(projectDir, { name: "a" }, deps);
		await handleUp(projectDir, { name: "b" }, deps);

		const entries = Object.values((await index()).deployments);
		expect(entries).toHaveLength(3);
		expect(entries.map((e) => e.slug).sort()).toEqual(["iso", "iso-a", "iso-b"]);
		expect(entries.map((e) => e.name).sort((x, y) => String(x).localeCompare(String(y))))
			.toEqual(["a", "b", null]);
	});

	it("re-ups the same (source, name) pair into the same entry", async () => {
		const deps = { up: fakeUp([]), indexDir, recordDir };
		await handleUp(projectDir, { name: "a" }, deps);
		const first = Object.keys((await index()).deployments);
		await handleUp(projectDir, { name: "a" }, deps);
		const second = Object.keys((await index()).deployments);
		expect(second).toEqual(first);
	});

	it("does not fold an unnamed up into an existing named instance", async () => {
		const deps = { up: fakeUp([]), indexDir, recordDir };
		await handleUp(projectDir, { name: "a" }, deps);
		await handleUp(projectDir, {}, deps);

		const idx = await index();
		expect(Object.keys(idx.deployments)).toHaveLength(2);
		expect(findBySource(idx, projectDir, null)?.entry.slug).toBe("iso");
		expect(findBySource(idx, projectDir, "a")?.entry.slug).toBe("iso-a");
	});
});

describe("the macOS provider refuses --name (D-59 floor)", () => {
	it("errors clearly instead of silently running the single unlabeled instance", async () => {
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
					{ native: true, name: "a" },
					{
						importMacos: async () =>
							({ launchUp: async () => {} }) as unknown as typeof import("@launchfile/macos-dev"),
						indexDir,
						recordDir,
					},
				),
			).rejects.toThrow("exited");
		} finally {
			process.exit = exit;
		}

		expect(exited).toBe(1);
		expect(output.join("\n")).toContain("--name is not yet supported by the macOS native provider");
		// Nothing launched, nothing recorded.
		expect(Object.keys((await index()).deployments)).toHaveLength(0);
	});
});
