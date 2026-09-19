import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaunch } from "@launchfile/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { prepareFingerprint } from "../prepare-fingerprint.js";
import { runSourcePrepare, type SourcePrepareContext } from "../provider.js";
import { initState, type LaunchState } from "../state.js";

async function tempProject(): Promise<string> {
	return mkdtemp(join(tmpdir(), "lf-prepare-"));
}

describe("prepareFingerprint", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await tempProject();
		return async () => {
			await rm(dir, { recursive: true, force: true });
		};
	});

	it("is stable across calls when nothing changed", async () => {
		await writeFile(
			join(dir, "package.json"),
			'{"dependencies":{"a":"1.0.0"}}',
		);
		const first = await prepareFingerprint(dir, "bun install");
		const second = await prepareFingerprint(dir, "bun install");
		expect(second).toBe(first);
	});

	it("changes when a lockfile's contents change", async () => {
		await writeFile(join(dir, "bun.lock"), "a@1.0.0");
		const before = await prepareFingerprint(dir, "bun install");
		await writeFile(join(dir, "bun.lock"), "a@2.0.0");
		expect(await prepareFingerprint(dir, "bun install")).not.toBe(before);
	});

	it("changes when a manifest changes with no lockfile present", async () => {
		await writeFile(join(dir, "package.json"), '{"dependencies":{}}');
		const before = await prepareFingerprint(dir, "npm install");
		await writeFile(
			join(dir, "package.json"),
			'{"dependencies":{"b":"1.0.0"}}',
		);
		expect(await prepareFingerprint(dir, "npm install")).not.toBe(before);
	});

	it("changes when a dependency file appears", async () => {
		const before = await prepareFingerprint(dir, "bundle install");
		await writeFile(join(dir, "Gemfile.lock"), "rails");
		expect(await prepareFingerprint(dir, "bundle install")).not.toBe(before);
	});

	it("changes when the prepare command changes", async () => {
		await writeFile(join(dir, "package.json"), "{}");
		const before = await prepareFingerprint(dir, "bun install");
		expect(await prepareFingerprint(dir, "bun install --production")).not.toBe(
			before,
		);
	});

	it("ignores files that are not dependency inputs", async () => {
		await writeFile(join(dir, "package.json"), "{}");
		const before = await prepareFingerprint(dir, "bun install");
		await writeFile(join(dir, "README.md"), "# hello");
		expect(await prepareFingerprint(dir, "bun install")).toBe(before);
	});

	it("returns a digest for a directory that does not exist", async () => {
		const missing = join(dir, "nope");
		expect(await prepareFingerprint(missing, "bun install")).toMatch(
			/^[0-9a-f]{16}$/,
		);
	});
});

/** Collects the commands a prepare run would have executed. */
function recorder() {
	const commands: string[] = [];
	const run: NonNullable<SourcePrepareContext["run"]> = async (command) => {
		commands.push(command);
		return undefined;
	};
	return { commands, run };
}

const SINGLE = `name: demo
components:
  web:
    commands:
      install: bun install
      dev: bun run dev
`;

describe("runSourcePrepare (D-38 on demand)", () => {
	let dir: string;
	let state: LaunchState;

	beforeEach(async () => {
		dir = await tempProject();
		state = initState("demo", SINGLE);
		await writeFile(join(dir, "bun.lock"), "a@1.0.0");
		return async () => {
			await rm(dir, { recursive: true, force: true });
		};
	});

	async function prepare(
		yaml: string,
		rec: ReturnType<typeof recorder>,
	): Promise<void> {
		await runSourcePrepare(readLaunch(yaml), {
			projectDir: dir,
			state,
			envs: {},
			run: rec.run,
			save: async () => {},
		});
	}

	it("runs on first launch and records the fingerprint", async () => {
		const rec = recorder();
		await prepare(SINGLE, rec);
		expect(rec.commands).toEqual(["bun install"]);
		expect(state.prepared?.web).toMatch(/^[0-9a-f]{16}$/);
	});

	it("does not run again when nothing changed", async () => {
		await prepare(SINGLE, recorder());
		const second = recorder();
		await prepare(SINGLE, second);
		expect(second.commands).toEqual([]);
	});

	it("runs again when the lockfile changes", async () => {
		await prepare(SINGLE, recorder());
		await writeFile(join(dir, "bun.lock"), "a@2.0.0");
		const second = recorder();
		await prepare(SINGLE, second);
		expect(second.commands).toEqual(["bun install"]);
	});

	it("runs again when the declared command changes", async () => {
		await prepare(SINGLE, recorder());
		const changed = SINGLE.replace(
			"install: bun install",
			"install: bun install --frozen-lockfile",
		);
		const second = recorder();
		await prepare(changed, second);
		expect(second.commands).toEqual(["bun install --frozen-lockfile"]);
	});

	it("falls back to `build` where no `install` is declared (install ?? build)", async () => {
		const buildOnly = `name: demo
components:
  web:
    commands:
      build: make deps
      dev: bun run dev
`;
		const rec = recorder();
		await prepare(buildOnly, rec);
		expect(rec.commands).toEqual(["make deps"]);
	});

	it("uses the package-manager fallback where a component declares neither", async () => {
		const bare = `name: demo
components:
  web:
    commands:
      dev: bun run dev
`;
		const rec = recorder();
		await runSourcePrepare(readLaunch(bare), {
			projectDir: dir,
			state,
			envs: {},
			fallbackCommand: "bun install",
			run: rec.run,
			save: async () => {},
		});
		expect(rec.commands).toEqual(["bun install"]);
	});

	it("skips a component with no prepare command and no fallback", async () => {
		const bare = `name: demo
components:
  web:
    commands:
      dev: bun run dev
`;
		const rec = recorder();
		await prepare(bare, rec);
		expect(rec.commands).toEqual([]);
		expect(state.prepared).toEqual({});
	});

	it("runs a shared prepare once on first launch", async () => {
		const shared = `name: demo
components:
  web:
    commands:
      install: bun install
      dev: bun run dev
  worker:
    commands:
      install: bun install
      dev: bun run worker
`;
		const rec = recorder();
		await prepare(shared, rec);
		expect(rec.commands).toEqual(["bun install"]);
		expect(state.prepared?.web).toBe(state.prepared?.worker);
	});

	it("prepares each component separately when their source directories differ", async () => {
		await mkdir(join(dir, "api"), { recursive: true });
		await writeFile(join(dir, "api", "bun.lock"), "a@1.0.0");
		const twoDirs = `name: demo
components:
  web:
    commands:
      install: bun install
      dev: bun run dev
  api:
    source: api
    commands:
      install: bun install
      dev: bun run api
`;
		const rec = recorder();
		await prepare(twoDirs, rec);
		expect(rec.commands).toEqual(["bun install", "bun install"]);
	});

	it("records nothing for a command that fails, so the next launch retries", async () => {
		const failing: SourcePrepareContext["run"] = async () => {
			throw new Error("install failed");
		};
		await expect(
			runSourcePrepare(readLaunch(SINGLE), {
				projectDir: dir,
				state,
				envs: {},
				run: failing,
				save: async () => {},
			}),
		).rejects.toThrow("install failed");
		expect(state.prepared).toEqual({});

		const retry = recorder();
		await prepare(SINGLE, retry);
		expect(retry.commands).toEqual(["bun install"]);
	});

	it("persists after each successful component so a later failure keeps the record", async () => {
		await mkdir(join(dir, "api"), { recursive: true });
		const twoComponents = `name: demo
components:
  web:
    commands:
      install: bun install
      dev: bun run dev
  api:
    source: api
    commands:
      install: cargo build
      dev: bun run api
`;
		const saved: LaunchState[] = [];
		const run: SourcePrepareContext["run"] = async (command) => {
			if (command === "cargo build") throw new Error("boom");
			return undefined;
		};
		await expect(
			runSourcePrepare(readLaunch(twoComponents), {
				projectDir: dir,
				state,
				envs: {},
				run,
				save: async (_dir, s) => {
					saved.push(structuredClone(s));
				},
			}),
		).rejects.toThrow("boom");
		expect(saved).toHaveLength(1);
		expect(Object.keys(saved[0]!.prepared ?? {})).toEqual(["web"]);
	});

	it("passes the component's resolved env to the command", async () => {
		const seen: (Record<string, string> | undefined)[] = [];
		const run: SourcePrepareContext["run"] = async (_command, opts) => {
			seen.push(opts.env);
			return undefined;
		};
		await runSourcePrepare(readLaunch(SINGLE), {
			projectDir: dir,
			state,
			envs: { web: { NODE_ENV: "development" } },
			run,
			save: async () => {},
		});
		expect(seen).toEqual([{ NODE_ENV: "development" }]);
	});

	it("honors a declared prepare timeout", async () => {
		const withTimeout = `name: demo
components:
  web:
    commands:
      install:
        command: bun install
        timeout: 30s
      dev: bun run dev
`;
		const seen: (number | undefined)[] = [];
		const run: SourcePrepareContext["run"] = async (_command, opts) => {
			seen.push(opts.timeout);
			return undefined;
		};
		await runSourcePrepare(readLaunch(withTimeout), {
			projectDir: dir,
			state,
			envs: {},
			run,
			save: async () => {},
		});
		expect(seen).toEqual([30_000]);
	});
});
