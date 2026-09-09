/**
 * The D-41 `--components` selector at the command layer (#232): the parsed
 * names reach either provider verbatim, an absent flag leaves both providers'
 * options exactly as they were, and the singular `--component` — which the
 * global flag table lets `up` parse — is refused instead of ignored.
 *
 * The selector is resolved by the providers through the SDK's shared
 * `selectionClosure`, so the command layer's whole job is to forward names
 * without filtering them. That is what these assert.
 *
 * Directories are injected temp paths — nothing touches the real
 * ~/.launchfile and nothing talks to docker.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerUpOpts, DockerUpResult } from "@launchfile/docker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleBootstrap } from "../commands/bootstrap.js";
import { handleUp } from "../commands/up.js";

let indexDir: string;
let recordDir: string;
let projectDir: string;

let output: string[];
let restore: (() => void) | null = null;

beforeEach(async () => {
	indexDir = await mkdtemp(join(tmpdir(), "lf-components-index-"));
	recordDir = await mkdtemp(join(tmpdir(), "lf-components-records-"));
	projectDir = await mkdtemp(join(tmpdir(), "lf-components-project-"));
	await writeFile(join(projectDir, "Launchfile"), "name: sel\n");

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
		return { slug: "sel", appName: "sel", sourceType: "local" };
	};
}

interface MacosUpOpts {
	components?: string[];
	storage?: Record<string, string>;
}

/** A macOS provider stub whose `launchUp` records the options it was handed. */
function fakeMacos(calls: MacosUpOpts[], onUp?: (opts: MacosUpOpts) => void) {
	return async () =>
		({
			launchUp: async (opts: MacosUpOpts) => {
				calls.push(opts);
				onUp?.(opts);
			},
		}) as unknown as typeof import("@launchfile/macos-dev");
}

/** Run `fn` with `process.exit` trapped; returns the exit code it requested. */
async function captureExit(fn: () => Promise<void>): Promise<number | undefined> {
	const exit = process.exit;
	let exited: number | undefined;
	process.exit = (code?: number) => {
		exited = code;
		throw new Error("exited");
	};
	try {
		await expect(fn()).rejects.toThrow("exited");
	} finally {
		process.exit = exit;
	}
	return exited;
}

describe("up --components reaches the docker provider (D-41)", () => {
	it("threads the selected names into the provider opts, in order", async () => {
		const calls: DockerUpOpts[] = [];
		await handleUp(
			projectDir,
			{ components: ["web", "api"] },
			{ up: fakeUp(calls), indexDir, recordDir },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.components).toEqual(["web", "api"]);
	});

	it("passes no selector when --components is absent, leaving today's opts unchanged", async () => {
		const calls: DockerUpOpts[] = [];
		await handleUp(projectDir, {}, { up: fakeUp(calls), indexDir, recordDir });
		expect(calls[0]!.components).toBeUndefined();
	});
});

describe("up --components reaches the macOS provider (D-41)", () => {
	it("threads the selected names into the provider opts, in order", async () => {
		const calls: MacosUpOpts[] = [];
		await handleUp(
			projectDir,
			{ native: true, components: ["web", "api"] },
			{ importMacos: fakeMacos(calls), indexDir, recordDir },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.components).toEqual(["web", "api"]);
	});

	it("passes no selector when --components is absent, leaving today's opts unchanged", async () => {
		const calls: MacosUpOpts[] = [];
		await handleUp(
			projectDir,
			{ native: true },
			{ importMacos: fakeMacos(calls), indexDir, recordDir },
		);
		expect(calls[0]!.components).toBeUndefined();
	});
});

describe("an unknown component name is the provider's refusal to make", () => {
	/**
	 * The command layer never checks a name against the Launchfile — the
	 * providers do, behind `selectionClosure`, and both already print
	 * `Cannot select: <names>` and exit 1. Filtering here would either mask
	 * that refusal or duplicate the closure the SDK owns.
	 */
	it("forwards a name that matches no component instead of dropping it", async () => {
		const calls: DockerUpOpts[] = [];
		await handleUp(
			projectDir,
			{ components: ["nope"] },
			{ up: fakeUp(calls), indexDir, recordDir },
		);
		expect(calls[0]!.components).toEqual(["nope"]);
	});

	it("lets the provider's refusal exit 1 with its own message, unwrapped", async () => {
		const exited = await captureExit(() =>
			handleUp(
				projectDir,
				{ native: true, components: ["nope"] },
				{
					importMacos: fakeMacos([], () => {
						// What `selectionClosure` drives in both providers today.
						console.error("\nCannot select: nope");
						process.exit(1);
					}),
					indexDir,
					recordDir,
				},
			),
		);
		expect(exited).toBe(1);
		expect(output.join("\n")).toContain("Cannot select: nope");
	});
});

describe("the singular --component is refused, never ignored", () => {
	it("stops `up` and names the flag that selects", async () => {
		const calls: DockerUpOpts[] = [];
		const exited = await captureExit(() =>
			handleUp(projectDir, { component: "web" }, { up: fakeUp(calls), indexDir, recordDir }),
		);
		expect(exited).toBe(1);
		expect(output.join("\n")).toContain("--components");
		// The whole point: no launch happened behind the ignored flag.
		expect(calls).toHaveLength(0);
	});

	it("stops `bootstrap` on the plural spelling and names --component", async () => {
		const exited = await captureExit(() => handleBootstrap(undefined, { components: "web" }));
		expect(exited).toBe(1);
		expect(output.join("\n")).toContain("--component <name>");
	});
});
