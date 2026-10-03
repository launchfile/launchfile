import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaunch } from "@launchfile/sdk";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchToCompose } from "../../compose-generator.js";
import { waitForHealth } from "../../provider.js";
import { shell } from "../../shell.js";

/**
 * The docker health gate against a real Docker daemon: the provider's own
 * generator writes the `healthcheck:` block, `docker compose up -d` starts the
 * container, and `waitForHealth` reads the real `docker compose ps`.
 *
 * Opt-in, so a contributor's `bun run test` stays daemon-free. With the flag
 * set, an unreachable daemon fails the suite: a skipped end-to-end test
 * reports green and proves nothing.
 *
 *   LAUNCHFILE_DOCKER_E2E=1 bun run test src/__tests__/e2e
 */
const ENABLED = process.env.LAUNCHFILE_DOCKER_E2E === "1";

/**
 * A shortened gate budget, passed only here. `up` itself always uses
 * HEALTH_TIMEOUT_MS: the budget is provider-side (D-48, P-11), so nothing
 * shipped can change it.
 */
const BUDGET = { maxWaitMs: 15_000, pollIntervalMs: 250 } as const;

const IMAGE = "busybox:1.37.0";
const FIXTURES = join(import.meta.dirname, "fixtures");

interface Launched {
	project: string;
	composeFile: string;
	healthchecks: Readonly<Record<string, boolean>>;
}

/** Every project a case started; `afterEach` tears each one down. */
const started: Launched[] = [];

async function docker(args: string[], timeout = 120_000): Promise<string> {
	const result = await shell("docker", args, { silent: true, timeout });
	return result.stdout;
}

/**
 * Generate a fixture's compose file with the provider's generator and start
 * it the way `up` does: `docker compose -p <project> -f <file> up -d`.
 */
async function launch(fixture: string): Promise<Launched> {
	const yaml = await readFile(join(FIXTURES, fixture, "Launchfile"), "utf8");
	const result = launchToCompose(readLaunch(yaml));

	const dir = await mkdtemp(join(tmpdir(), `lf-e2e-${fixture}-`));
	const composeFile = join(dir, "docker-compose.yml");
	await writeFile(composeFile, result.yaml, { mode: 0o600 });

	const launched: Launched = {
		project: `lf-e2e-${fixture}-${process.pid}`,
		composeFile,
		healthchecks: result.healthchecks,
	};
	started.push(launched);

	await docker([
		"compose",
		"-p",
		launched.project,
		"-f",
		composeFile,
		"up",
		"-d",
	]);
	return launched;
}

async function restartCount({
	project,
	composeFile,
}: Launched): Promise<number> {
	const ids = (
		await docker([
			"compose",
			"-p",
			project,
			"-f",
			composeFile,
			"ps",
			"--all",
			"-q",
		])
	)
		.split("\n")
		.filter(Boolean);
	let total = 0;
	for (const id of ids) {
		total += Number(
			(await docker(["inspect", "-f", "{{.RestartCount}}", id])).trim(),
		);
	}
	return total;
}

describe.skipIf(!ENABLED)("docker health gate against a real daemon", () => {
	beforeAll(async () => {
		const info = await shell(
			"docker",
			["info", "--format", "{{.ServerVersion}}"],
			{
				silent: true,
				allowFailure: true,
				timeout: 30_000,
			},
		);
		if (info.exitCode !== 0) {
			throw new Error(
				`LAUNCHFILE_DOCKER_E2E=1 is set but no Docker daemon is reachable ` +
					`(docker info exited ${info.exitCode}): ${info.stderr.trim()}`,
			);
		}
		await docker(["pull", "--quiet", IMAGE], 300_000);
	}, 320_000);

	afterEach(async () => {
		for (const { project, composeFile } of started.splice(0)) {
			await docker([
				"compose",
				"-p",
				project,
				"-f",
				composeFile,
				"down",
				"-v",
				"--remove-orphans",
			]);
		}
	}, 60_000);

	it("passes a container whose declared check passes", async () => {
		const app = await launch("healthy");
		expect(app.healthchecks).toEqual({ "lf-e2e-healthy": true });

		const outcome = await waitForHealth(
			app.project,
			app.composeFile,
			app.healthchecks,
			BUDGET,
		);

		expect(outcome).toEqual({ ok: true, stuck: [] });
	}, 60_000);

	it("fails a crash-looping container and names it as stuck", async () => {
		const app = await launch("crash-loop");
		expect(app.healthchecks).toEqual({ "lf-e2e-crash-loop": true });

		const outcome = await waitForHealth(
			app.project,
			app.composeFile,
			app.healthchecks,
			BUDGET,
		);

		expect(outcome.ok).toBe(false);
		expect(outcome.stuck).toContain("lf-e2e-crash-loop");
		// The failure is the crash loop, not a container that never started.
		expect(await restartCount(app)).toBeGreaterThan(0);
	}, 60_000);

	it("waits for a slow container that becomes healthy within the budget", async () => {
		const app = await launch("slow-healthy");
		expect(app.healthchecks).toEqual({ "lf-e2e-slow-healthy": true });

		const t0 = Date.now();
		const outcome = await waitForHealth(
			app.project,
			app.composeFile,
			app.healthchecks,
			BUDGET,
		);
		const elapsed = Date.now() - t0;

		expect(outcome).toEqual({ ok: true, stuck: [] });
		// The gate saw it unhealthy first and kept polling.
		expect(elapsed).toBeGreaterThan(3_000);
		expect(await restartCount(app)).toBe(0);
	}, 60_000);
});
