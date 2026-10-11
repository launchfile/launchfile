/**
 * The deployment index keys a row by target kind (#613, D-55): a directory for
 * a local target, `catalog:<slug>` for a catalog target, the URL itself for a
 * URL target. URL rows that still carry a `catalog:` prefix match, display,
 * and get rewritten as the URL.
 *
 * Directories are injected temp paths — nothing touches the real ~/.launchfile
 * and nothing talks to docker. Every `handleUp` call passes `docker: true` so
 * `detectProvider` never spawns `docker info`.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerUpOpts, DockerUpResult } from "@launchfile/docker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleList } from "../commands/list.js";
import { handleUp } from "../commands/up.js";
import { resolveDeploymentTarget } from "../resolve-target.js";
import {
	entrySource,
	findBySource,
	loadIndex,
	saveIndex,
} from "../state/index.js";
import type { DeploymentEntry } from "../state/types.js";

const URL_TARGET = "https://example.com/app/Launchfile";

let indexDir: string;
let recordDir: string;
let output: string[];
let restore: (() => void) | null = null;

beforeEach(async () => {
	indexDir = await mkdtemp(join(tmpdir(), "lf-srckey-index-"));
	recordDir = await mkdtemp(join(tmpdir(), "lf-srckey-records-"));

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

function fakeUp(sourceType: "catalog" | "url") {
	return async (
		_source: string,
		_opts: DockerUpOpts,
	): Promise<DockerUpResult> => ({
		slug: "app",
		appName: "app",
		sourceType,
	});
}

function makeEntry(overrides: Partial<DeploymentEntry> = {}): DeploymentEntry {
	return {
		appName: "app",
		provider: "docker",
		source: `catalog:${URL_TARGET}`,
		sourceType: "url",
		slug: "app",
		name: null,
		port: null,
		status: "up",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("up keys the index by target kind", () => {
	it("keys a URL target by the URL itself", async () => {
		await handleUp(
			URL_TARGET,
			{ docker: true },
			{ up: fakeUp("url"), indexDir, recordDir },
		);
		const rows = Object.values((await loadIndex(indexDir)).deployments);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.source).toBe(URL_TARGET);
		expect(rows[0]!.sourceType).toBe("url");
	});

	it("keys a catalog target as catalog:<slug>", async () => {
		await handleUp(
			"ghost",
			{ docker: true },
			{ up: fakeUp("catalog"), indexDir, recordDir },
		);
		const rows = Object.values((await loadIndex(indexDir)).deployments);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.source).toBe("catalog:ghost");
		expect(rows[0]!.sourceType).toBe("catalog");
	});

	it("reuses a legacy catalog:<url> row and rewrites its source", async () => {
		await saveIndex(
			{ version: 1, deployments: { abc1234: makeEntry() } },
			indexDir,
		);
		await handleUp(
			URL_TARGET,
			{ docker: true },
			{ up: fakeUp("url"), indexDir, recordDir },
		);
		const index = await loadIndex(indexDir);
		expect(Object.keys(index.deployments)).toEqual(["abc1234"]);
		expect(index.deployments.abc1234!.source).toBe(URL_TARGET);
		expect(index.deployments.abc1234!.createdAt).toBe(
			"2026-01-01T00:00:00.000Z",
		);
	});
});

describe("entrySource", () => {
	it("strips a legacy catalog: prefix from a URL row", () => {
		expect(entrySource(makeEntry())).toBe(URL_TARGET);
	});

	it("keeps the prefix on a catalog row", () => {
		expect(
			entrySource(
				makeEntry({ source: "catalog:ghost", sourceType: "catalog" }),
			),
		).toBe("catalog:ghost");
	});

	it("returns a URL row's source unchanged", () => {
		expect(entrySource(makeEntry({ source: URL_TARGET }))).toBe(URL_TARGET);
	});

	it("never matches a legacy URL row against a catalog key", () => {
		const index = {
			version: 1 as const,
			deployments: { abc1234: makeEntry() },
		};
		expect(findBySource(index, `catalog:${URL_TARGET}`)).toBeNull();
		expect(findBySource(index, URL_TARGET)?.id).toBe("abc1234");
	});
});

describe("URL rows display without a catalog: prefix", () => {
	it("launchfile list shows the bare URL for a legacy row", async () => {
		await saveIndex(
			{ version: 1, deployments: { abc1234: makeEntry() } },
			indexDir,
		);
		await handleList(indexDir);
		const printed = output.join("\n");
		expect(printed).toContain(URL_TARGET);
		expect(printed).not.toContain("catalog:http");
	});

	it("the ambiguity message shows the bare URL for a legacy row", async () => {
		await saveIndex(
			{
				version: 1,
				deployments: {
					abc1234: makeEntry(),
					def5678: makeEntry({ source: "catalog:app", sourceType: "catalog" }),
				},
			},
			indexDir,
		);
		const exit = process.exit;
		let exited: number | undefined;
		process.exit = ((code?: number) => {
			exited = code;
			throw new Error("exited");
		}) as typeof process.exit;
		try {
			await expect(resolveDeploymentTarget("app", indexDir)).rejects.toThrow(
				"exited",
			);
		} finally {
			process.exit = exit;
		}
		expect(exited).toBe(1);
		const printed = output.join("\n");
		expect(printed).toContain(`abc1234  (unnamed)  ${URL_TARGET}`);
		expect(printed).toContain("def5678  (unnamed)  catalog:app");
		expect(printed).not.toContain("catalog:http");
	});
});
