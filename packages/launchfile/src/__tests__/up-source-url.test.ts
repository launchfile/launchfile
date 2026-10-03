/**
 * A URL target's credentials never reach the deployment index (#627, D-55
 * rule 3). The index keys a URL deployment by its canonical form, and a lookup
 * compares canonical forms on both sides, so a rotated token re-ups the same
 * row and an older row holding the raw URL still matches.
 *
 * Directories are injected temp paths — nothing touches the real
 * ~/.launchfile and nothing talks to docker. Every `handleUp` call passes
 * `docker: true` so `detectProvider` does not spawn `docker info`.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerUpOpts, DockerUpResult } from "@launchfile/docker";
import { buildLaunchErrorContext, LaunchError } from "@launchfile/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleUp } from "../commands/up.js";
import { findBySource, loadIndex } from "../state/index.js";
import type { DeploymentIndex } from "../state/types.js";

const TOKEN_URL =
	"https://user:tok-USERINFO-627@host.example/apps/notes/Launchfile?token=tok-QUERY-627&ref=v1";
const CANONICAL_KEY =
	"catalog:https://host.example/apps/notes/Launchfile?ref=v1";

let indexDir: string;
let recordDir: string;
let restore: (() => void) | null = null;

beforeEach(async () => {
	indexDir = await mkdtemp(join(tmpdir(), "lf-srcurl-index-"));
	recordDir = await mkdtemp(join(tmpdir(), "lf-srcurl-records-"));
	const log = console.log;
	const err = console.error;
	console.log = () => undefined;
	console.error = () => undefined;
	restore = () => {
		console.log = log;
		console.error = err;
	};
});

afterEach(() => {
	restore?.();
	restore = null;
});

const fakeUp = async (
	_source: string,
	_opts: DockerUpOpts,
): Promise<DockerUpResult> => ({
	slug: "notes",
	appName: "notes",
	sourceType: "url",
	sourceUrl: "https://host.example/apps/notes/Launchfile?ref=v1",
});

async function rawIndex(): Promise<string> {
	return readFile(join(indexDir, "index.json"), "utf8");
}

function expectNoCredential(text: string): void {
	expect(text).not.toContain("tok-USERINFO-627");
	expect(text).not.toContain("tok-QUERY-627");
	expect(text).not.toContain("user:");
}

describe("a URL up writes no credential to index.json (#627)", () => {
	it("keys the row by the canonical URL", async () => {
		await handleUp(
			TOKEN_URL,
			{ docker: true },
			{ up: fakeUp, indexDir, recordDir },
		);

		expectNoCredential(await rawIndex());
		const entries = Object.values((await loadIndex(indexDir)).deployments);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.source).toBe(CANONICAL_KEY);
	});

	it("records a failed launch without the credential too", async () => {
		const failingUp = async (): Promise<DockerUpResult> => {
			throw new LaunchError(
				buildLaunchErrorContext(
					{
						phase: "health",
						provider: "docker",
						key: "notes",
						slug: "notes",
						app: "notes",
						message: "start failed",
					},
					(text: string): string => text,
				),
			);
		};
		await expect(
			handleUp(
				TOKEN_URL,
				{ docker: true },
				{ up: failingUp, indexDir, recordDir },
			),
		).rejects.toThrow("start failed");

		expectNoCredential(await rawIndex());
		const entries = Object.values((await loadIndex(indexDir)).deployments);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.source).toBe(CANONICAL_KEY);
	});

	it("re-ups the same row when only the token changes", async () => {
		const deps = { up: fakeUp, indexDir, recordDir };
		await handleUp(TOKEN_URL, { docker: true }, deps);
		const first = Object.keys((await loadIndex(indexDir)).deployments);
		await handleUp(
			TOKEN_URL.replace(/tok-/g, "rotated-"),
			{ docker: true },
			deps,
		);
		expect(Object.keys((await loadIndex(indexDir)).deployments)).toEqual(first);
	});

	it("re-ups the same row when the token is dropped next to a ref holding '/'", async () => {
		const deps = { up: fakeUp, indexDir, recordDir };
		const base = "https://host.example/apps/notes/Launchfile";
		await handleUp(
			`${base}?token=tok-QUERY-627&ref=release/1.0`,
			{ docker: true },
			deps,
		);
		await handleUp(`${base}?ref=release/1.0`, { docker: true }, deps);
		const entries = Object.values((await loadIndex(indexDir)).deployments);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.source).toBe(`catalog:${base}?ref=release/1.0`);
	});

	it("a different ?ref= is a different row", async () => {
		const deps = { up: fakeUp, indexDir, recordDir };
		await handleUp(TOKEN_URL, { docker: true }, deps);
		await handleUp(
			TOKEN_URL.replace("ref=v1", "ref=v2"),
			{ docker: true },
			deps,
		);
		expect(Object.keys((await loadIndex(indexDir)).deployments)).toHaveLength(
			2,
		);
	});

	it("matches an older row holding the raw URL and rewrites it canonical", async () => {
		const legacy: DeploymentIndex = {
			version: 1,
			deployments: {
				abc1234: {
					appName: "notes",
					slug: "notes",
					provider: "docker",
					source: `catalog:${TOKEN_URL}`,
					sourceType: "url",
					name: null,
					port: null,
					status: "up",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		};
		await writeFile(join(indexDir, "index.json"), JSON.stringify(legacy));
		expect(findBySource(legacy, CANONICAL_KEY, null)?.id).toBe("abc1234");

		await handleUp(
			TOKEN_URL.replace(/tok-/g, "rotated-"),
			{ docker: true },
			{
				up: fakeUp,
				indexDir,
				recordDir,
			},
		);

		expectNoCredential(await rawIndex());
		const idx = await loadIndex(indexDir);
		expect(Object.keys(idx.deployments)).toEqual(["abc1234"]);
		expect(idx.deployments.abc1234!.source).toBe(CANONICAL_KEY);
	});
});
