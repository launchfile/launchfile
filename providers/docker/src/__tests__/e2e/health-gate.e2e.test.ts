import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
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
	dir: string;
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
		dir,
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

async function containerIds({
	project,
	composeFile,
}: Launched): Promise<string[]> {
	const out = await docker([
		"compose",
		"-p",
		project,
		"-f",
		composeFile,
		"ps",
		"--all",
		"-q",
	]);
	return out.split("\n").filter(Boolean);
}

async function restartCount(app: Launched): Promise<number> {
	let total = 0;
	for (const id of await containerIds(app)) {
		total += Number(
			(await docker(["inspect", "-f", "{{.RestartCount}}", id])).trim(),
		);
	}
	return total;
}

/**
 * Exit codes of the health probes docker still holds for the app's containers,
 * oldest first. Docker keeps only the last five probes per container.
 */
async function probeExitCodes(app: Launched): Promise<number[]> {
	const codes: number[] = [];
	for (const id of await containerIds(app)) {
		const log = JSON.parse(
			await docker(["inspect", "-f", "{{json .State.Health.Log}}", id]),
		) as { ExitCode: number }[] | null;
		for (const probe of log ?? []) codes.push(probe.ExitCode);
	}
	return codes;
}

async function tearDown({
	project,
	dir,
	composeFile,
}: Launched): Promise<void> {
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
	await unlink(composeFile);
	await rmdir(dir);
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
		// Pull only when the image is missing, so a registry rate limit cannot
		// fail a run that already has it.
		const cached = await shell("docker", ["image", "inspect", IMAGE], {
			silent: true,
			allowFailure: true,
			timeout: 30_000,
		});
		if (cached.exitCode !== 0) {
			await docker(["pull", "--quiet", IMAGE], 300_000);
		}
	}, 360_000);

	afterEach(async () => {
		const results = await Promise.allSettled(started.splice(0).map(tearDown));
		const failures = results.flatMap((r) =>
			r.status === "rejected" ? [r.reason] : [],
		);
		if (failures.length > 0) {
			throw new AggregateError(failures, "docker e2e teardown failed");
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

	it("passes a running container that declares no health check", async () => {
		const app = await launch("no-health");
		expect(app.healthchecks).toEqual({ "lf-e2e-no-health": false });

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
		expect(outcome.stuck).toEqual(["lf-e2e-crash-loop"]);
		// The failure is the crash loop, not a container that never started.
		expect(await restartCount(app)).toBeGreaterThan(0);
	}, 60_000);

	it("waits for a slow container that becomes healthy within the budget", async () => {
		const app = await launch("slow-healthy");
		expect(app.healthchecks).toEqual({ "lf-e2e-slow-healthy": true });

		const outcome = await waitForHealth(
			app.project,
			app.composeFile,
			app.healthchecks,
			BUDGET,
		);

		expect(outcome).toEqual({ ok: true, stuck: [] });
		// Its check failed before it passed, so the gate waited through failing
		// probes rather than catching it already healthy.
		const codes = await probeExitCodes(app);
		expect(
			codes.some((code) => code !== 0),
			`probe exit codes ${codes}`,
		).toBe(true);
		expect(codes.at(-1)).toBe(0);
		expect(await restartCount(app)).toBe(0);
	}, 60_000);
});
