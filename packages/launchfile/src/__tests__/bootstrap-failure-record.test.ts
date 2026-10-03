/**
 * A failed native `launchfile bootstrap` leaves a record `diagnose` can read
 * (#44, D-48), and that record carries no declared-sensitive (D-18) or
 * operator-supplied (D-52) value. The real macos-dev `launchBootstrap` runs
 * with an injected exec, and the CLI builds the record through `importMacos`
 * with that same module, so the redactor registration is exercised in the
 * module instance that redacts. The provider is imported from its `src/`
 * because CI never builds its `dist/` (see macos-dev-declaration.types.ts).
 * Vitest isolates each file, so the registry starts empty, as it does in a
 * fresh `bootstrap` process that never ran `up`. Nothing touches the real
 * ~/.launchfile and no process is spawned.
 */

import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceErrorKey } from "@launchfile/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as macosDev from "../../../../providers/macos-dev/src/index.js";
import { handleBootstrap } from "../commands/bootstrap.js";
import { readLaunchErrorRecord } from "../state/errors.js";
import { type DeploymentEntry, saveIndex } from "../state/index.js";

const PIN = "424242";
const OPERATOR_TOKEN = "op-supplied-7c1e0b9a";
const LAUNCHFILE = `name: acme
version: "1.0"
components:
  api:
    env:
      DEVICE_PIN:
        default: "${PIN}"
        sensitive: true
      OPERATOR_TOKEN:
        required: true
    commands:
      start: "node server.js"
      bootstrap: "printenv DEVICE_PIN OPERATOR_TOKEN; exit 3"
`;

let indexDir: string;
let recordDir: string;
let projectDir: string;
let exited: number | undefined;
let savedToken: string | undefined;
let restore: () => void;

beforeEach(async () => {
	indexDir = await mkdtemp(join(tmpdir(), "lf-bootrec-index-"));
	recordDir = await mkdtemp(join(tmpdir(), "lf-bootrec-records-"));
	projectDir = await mkdtemp(join(tmpdir(), "lf-bootrec-project-"));
	await writeFile(join(projectDir, "Launchfile"), LAUNCHFILE);
	await mkdir(join(projectDir, ".launchfile"), { recursive: true });
	const now = new Date().toISOString();
	await writeFile(
		join(projectDir, ".launchfile", "state.json"),
		JSON.stringify({
			version: 1,
			appName: "acme",
			launchfileHash: "0".repeat(16),
			createdAt: now,
			updatedAt: now,
			resources: {},
			secrets: {},
			ports: { api: 3000 },
		}),
	);
	const entry: DeploymentEntry = {
		appName: "acme",
		provider: "macos",
		source: projectDir,
		sourceType: "local",
		slug: "acme",
		name: null,
		port: null,
		status: "up",
		createdAt: now,
		updatedAt: now,
	};
	await saveIndex({ version: 1, deployments: { m1: entry } }, indexDir);

	savedToken = process.env.OPERATOR_TOKEN;
	process.env.OPERATOR_TOKEN = OPERATOR_TOKEN;
	exited = undefined;
	const exit = process.exit;
	const log = console.log;
	const error = console.error;
	// The first exit code wins: the macos branch's catch re-exits with 1 when
	// the thrown stand-in for exit(1) reaches it.
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
	if (savedToken === undefined) delete process.env.OPERATOR_TOKEN;
	else process.env.OPERATOR_TOKEN = savedToken;
	await rm(indexDir, { recursive: true, force: true });
	await rm(recordDir, { recursive: true, force: true });
	await rm(projectDir, { recursive: true, force: true });
});

describe("macos bootstrap failure record", () => {
	it("writes a reported bootstrap record under the source key, with the env values redacted", async () => {
		const echoed = `${PIN}\n${OPERATOR_TOKEN}\n`;
		await expect(
			handleBootstrap(
				"m1",
				{},
				{
					indexDir,
					recordDir,
					importMacos: async () =>
						macosDev as unknown as typeof import("@launchfile/macos-dev"),
					macosBootstrap: (opts) =>
						macosDev.launchBootstrap({
							...opts,
							exec: async () => ({
								exitCode: 3,
								stdout: echoed,
								stderr: echoed,
							}),
						}),
				},
			),
		).rejects.toThrow("exited");
		expect(exited).toBe(1);

		const record = await readLaunchErrorRecord(
			sourceErrorKey(projectDir),
			recordDir,
		);
		expect(record?.phase).toBe("bootstrap");
		expect(record?.disposition).toBe("reported");
		expect(record?.component).toBe("api");
		expect(record?.exitCode).toBe(3);

		// Every byte written to the record directory, not just the parsed fields.
		for (const file of await readdir(recordDir)) {
			const raw = await readFile(join(recordDir, file), "utf-8");
			expect(raw).not.toContain(PIN);
			expect(raw).not.toContain(OPERATOR_TOKEN);
		}
	});
});
