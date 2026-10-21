/**
 * Deployment index on disk (#408, CWE-276).
 *
 * The directory is injected rather than faked through $HOME: Bun's os.homedir()
 * ignores the variable, so an env override would silently write to the real one.
 * Loose modes are set with an explicit `chmod`, never `mkdir`'s `mode`: that
 * one is masked by the umask, so under a restrictive umask the fixture would be
 * born 0o700 and the assertion would pass without the retrofit running.
 */

import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	addDeployment,
	deploymentDir,
	loadIndex,
	saveIndex,
} from "../state/index.js";
import type { DeploymentEntry, DeploymentIndex } from "../state/types.js";

let dir: string;

beforeEach(async () => {
	dir = join(await mkdtemp(join(tmpdir(), "lf-index-")), "deployments");
});

function entry(): DeploymentEntry {
	const now = new Date().toISOString();
	return {
		appName: "demo",
		provider: "docker",
		source: "/code/demo",
		sourceType: "local",
		name: null,
		port: 3000,
		status: "up",
		createdAt: now,
		updatedAt: now,
	};
}

async function mode(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

describe("saveIndex", () => {
	it("creates the deployments directory at 0o700 and index.json at 0o600", async () => {
		await saveIndex({ version: 1, deployments: {} }, dir);
		expect(await mode(dir)).toBe(0o700);
		expect(await mode(join(dir, "index.json"))).toBe(0o600);
	});

	it("tightens a pre-existing deployments directory that is too open", async () => {
		await mkdir(dir, { recursive: true });
		await chmod(dir, 0o755);
		await saveIndex({ version: 1, deployments: {} }, dir);
		expect(await mode(dir)).toBe(0o700);
	});

	it("rewrites a pre-existing 0o644 index.json at 0o600 with the new content", async () => {
		await mkdir(dir, { recursive: true });
		const path = join(dir, "index.json");
		await writeFile(path, '{"version":1,"deployments":{}}\n');
		await chmod(path, 0o644);

		const index: DeploymentIndex = {
			version: 1,
			deployments: { abc1234: entry() },
		};
		await saveIndex(index, dir);

		expect(await mode(path)).toBe(0o600);
		expect(await loadIndex(dir)).toEqual(index);
		// The temp file the atomic write goes through is gone after the rename.
		expect(await readdir(dir)).toEqual(["index.json"]);
	});

	it("rejects when the deployments path is a file", async () => {
		await mkdir(join(dir, ".."), { recursive: true });
		await writeFile(dir, "not a directory\n");
		await expect(
			saveIndex({ version: 1, deployments: {} }, dir),
		).rejects.toThrow();
	});
});

describe("addDeployment", () => {
	it("creates the per-deployment directory at 0o700", async () => {
		await addDeployment("abc1234", entry(), dir);
		expect(await mode(deploymentDir("abc1234", dir))).toBe(0o700);
	});

	it("tightens a pre-existing per-deployment directory that is too open", async () => {
		const perDeployment = deploymentDir("abc1234", dir);
		await mkdir(perDeployment, { recursive: true });
		await chmod(perDeployment, 0o755);
		await addDeployment("abc1234", entry(), dir);
		expect(await mode(perDeployment)).toBe(0o700);
	});
});
