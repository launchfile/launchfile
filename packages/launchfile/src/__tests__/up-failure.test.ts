/**
 * The two things `up` does on a failing launch: capture the record, and keep the
 * deployment index honest about what is on the machine.
 *
 * Both directories are injected at temp paths — nothing here reads or writes the
 * real `~/.launchfile`, and nothing here talks to docker.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildLaunchErrorContext,
	LaunchError,
	type LaunchPhase,
} from "@launchfile/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	failedDeploymentStatus,
	handleUp,
	loadMacosProvider,
	withFailureRecord,
} from "../commands/up.js";
import { handleDiagnose } from "../commands/diagnose.js";
import { resolveDeploymentTarget } from "../resolve-target.js";
import { dockerSlugFor, loadIndex } from "../state/index.js";
import { readLaunchErrorRecord } from "../state/errors.js";
import type { DeploymentIndex } from "../state/types.js";

const IDENTITY = (s: string): string => s;

let indexDir: string;
let recordDir: string;
let projectDir: string;

/** Everything the command wrote to stdout/stderr during one test. */
let output: string[];
let restore: (() => void) | null = null;

beforeEach(async () => {
	indexDir = await mkdtemp(join(tmpdir(), "lf-index-"));
	recordDir = await mkdtemp(join(tmpdir(), "lf-records-"));
	projectDir = await mkdtemp(join(tmpdir(), "lf-project-"));
	await writeFile(join(projectDir, "Launchfile"), "name: gov23\n");

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

function launchError(phase: LaunchPhase, message = "it broke"): LaunchError {
	return new LaunchError(
		buildLaunchErrorContext(
			{
				phase,
				provider: "docker",
				key: "gov23",
				slug: "gov23",
				app: "gov23",
				message,
			},
			IDENTITY,
		),
	);
}

function deps(up: () => Promise<never>) {
	return { up, indexDir, recordDir };
}

async function index(): Promise<DeploymentIndex> {
	return loadIndex(indexDir);
}

describe("failedDeploymentStatus", () => {
	it("records a health-gate failure as unhealthy — the containers are running", () => {
		expect(failedDeploymentStatus("health")).toBe("unhealthy");
	});

	it("records a release or run failure as unknown — some containers exist", () => {
		expect(failedDeploymentStatus("release")).toBe("unknown");
		expect(failedDeploymentStatus("run")).toBe("unknown");
	});

	it("records nothing for a failure refused before any container started", () => {
		for (const phase of [
			"prereq",
			"resolve",
			"parse",
			"provision",
			"prepare",
		] as const) {
			expect(failedDeploymentStatus(phase)).toBeNull();
		}
	});
});

describe("up, when the health gate never passes", () => {
	it("exits non-zero, and leaves a deployment every remediation command can reach", async () => {
		const message = "component(s) web did not become healthy within 120s";
		await expect(
			handleUp(projectDir, {}, deps(() => Promise.reject(launchError("health", message)))),
		).rejects.toThrow(message);

		// The index says a deployment exists, because it does: the health gate
		// leaves the containers running on purpose.
		const entries = Object.entries((await index()).deployments);
		expect(entries).toHaveLength(1);
		const [id, entry] = entries[0]!;
		expect(entry.status).toBe("unhealthy");
		expect(entry.slug).toBe("gov23");
		expect(entry.source).toBe(projectDir);

		// `status`, `logs`, and `down` all resolve through this one call, and each
		// then addresses the provider by a key this entry carries.
		const resolved = await resolveDeploymentTarget(projectDir, indexDir);
		expect(resolved.id).toBe(id);
		expect(dockerSlugFor(resolved.entry)).toBe("gov23"); // down
		expect(resolved.entry.appName).toBe("gov23"); // status, logs

		// And `diagnose` names the phase.
		const record = await readLaunchErrorRecord("gov23", recordDir);
		expect(record?.phase).toBe("health");
		expect(record?.disposition).toBe("failed-invocation");

		let json = "";
		const code = await handleDiagnose(
			undefined,
			{ json: true },
			{ out: (t) => (json += t), err: () => undefined },
			recordDir,
		);
		expect(code).toBe(0);
		expect(JSON.parse(json).phase).toBe("health");
	});

	it("tells the user the deployment was recorded", async () => {
		await expect(
			handleUp(projectDir, {}, deps(() => Promise.reject(launchError("health")))),
		).rejects.toThrow();
		expect(output.join("\n")).toContain("recorded as unhealthy");
	});
});

describe("up, on the other failure phases", () => {
	it("registers a release failure too — its one-shot containers pulled resources up", async () => {
		await expect(
			handleUp(projectDir, {}, deps(() => Promise.reject(launchError("release")))),
		).rejects.toThrow();
		const entries = Object.values((await index()).deployments);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.status).toBe("unknown");
	});

	it("registers nothing when the launch was refused before a container existed", async () => {
		await expect(
			handleUp(projectDir, {}, deps(() => Promise.reject(launchError("prereq")))),
		).rejects.toThrow();
		expect(Object.keys((await index()).deployments)).toHaveLength(0);
		// The record still lands — that is what `diagnose` reads for a pre-deploy
		// failure, which has no index entry to look itself up by.
		expect((await readLaunchErrorRecord("gov23", recordDir))?.phase).toBe("prereq");
	});

	it("registers nothing for a --dry-run failure", async () => {
		await expect(
			handleUp(
				projectDir,
				{ dryRun: true },
				deps(() => Promise.reject(launchError("health"))),
			),
		).rejects.toThrow();
		expect(Object.keys((await index()).deployments)).toHaveLength(0);
	});
});

describe("withFailureRecord", () => {
	it("writes the record a LaunchError carries, then re-throws it", async () => {
		const err = launchError("run", "start failed with exit code 1");
		await expect(
			withFailureRecord(() => Promise.reject(err), recordDir),
		).rejects.toBe(err);

		const record = await readLaunchErrorRecord("gov23", recordDir);
		expect(record?.phase).toBe("run");
		expect(record?.message).toBe("start failed with exit code 1");
	});

	it("passes a failure carrying no context through unrecorded", async () => {
		const err = new Error("something else went wrong");
		await expect(
			withFailureRecord(() => Promise.reject(err), recordDir),
		).rejects.toBe(err);
		expect(await readLaunchErrorRecord(undefined, recordDir)).toBeNull();
	});

	it("returns the value on success and writes nothing", async () => {
		await expect(withFailureRecord(async () => "ok", recordDir)).resolves.toBe("ok");
		expect(await readLaunchErrorRecord(undefined, recordDir)).toBeNull();
	});
});

describe("the macOS branch's try-split", () => {
	it("reports a missing provider package as a missing provider package", async () => {
		const exit = process.exit;
		let exited: number | undefined;
		process.exit = (code?: number) => {
			exited = code;
			throw new Error("exited");
		};
		try {
			await expect(
				loadMacosProvider(() =>
					Promise.reject(new Error("Cannot find module '@launchfile/macos-dev'")),
				),
			).rejects.toThrow("exited");
		} finally {
			process.exit = exit;
		}

		expect(exited).toBe(1);
		expect(output.join("\n")).toContain("macOS native provider not available.");
	});

	it("reports a launch failure as itself, not as a missing provider package", async () => {
		const fake = {
			launchUp: () => Promise.reject(launchError("release", "release [web] failed")),
		} as unknown as typeof import("@launchfile/macos-dev");

		await expect(
			handleUp(
				projectDir,
				{ native: true },
				{ importMacos: async () => fake, indexDir, recordDir },
			),
		).rejects.toThrow("release [web] failed");

		const printed = output.join("\n");
		expect(printed).not.toContain("macOS native provider not available.");
		expect(printed).toContain("Captured.");
	});
});
