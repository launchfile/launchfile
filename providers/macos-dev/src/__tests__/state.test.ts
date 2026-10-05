import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { initState, hashLaunchfile, loadState, saveState, ensureDirs, type LaunchState } from "../state.js";
import { clearRegisteredSecrets, redactSecrets, REDACTED } from "../redact.js";

describe("initState", () => {
	it("creates a state with correct app name", () => {
		const state = initState("my-app", "name: my-app");
		expect(state.appName).toBe("my-app");
		expect(state.version).toBe(1);
		expect(state.resources).toEqual({});
		expect(state.secrets).toEqual({});
		expect(state.ports).toEqual({});
	});

	it("hashes launchfile content", () => {
		const state = initState("app", "some yaml content");
		expect(state.launchfileHash).toBeTruthy();
		expect(state.launchfileHash.length).toBe(16);
	});
});

describe("hashLaunchfile", () => {
	it("is deterministic", () => {
		const a = hashLaunchfile("hello");
		const b = hashLaunchfile("hello");
		expect(a).toBe(b);
	});

	it("differs for different content", () => {
		const a = hashLaunchfile("hello");
		const b = hashLaunchfile("world");
		expect(a).not.toBe(b);
	});
});

describe("state persistence of processes (issue #49)", () => {
	async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
		const dir = await mkdtemp(join(tmpdir(), "launchfile-state-"));
		try {
			return await fn(dir);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	it("round-trips the processes field (pid/pgid/startedAt/command)", async () => {
		await withTempDir(async (dir) => {
			const state = initState("my-app", "name: my-app");
			state.processes = {
				web: { pid: 1234, pgid: 1234, startedAt: "2026-06-18T00:00:00.000Z", command: "sh -c 'bun start'" },
			};
			await saveState(dir, state);

			const loaded = await loadState(dir);
			expect(loaded?.processes?.web).toEqual({
				pid: 1234,
				pgid: 1234,
				startedAt: "2026-06-18T00:00:00.000Z",
				command: "sh -c 'bun start'",
			});
		});
	});

	it("initState omits processes (field is optional, absent by default)", () => {
		const state = initState("app", "yaml");
		expect(state.processes).toBeUndefined();
	});

	it("loads a legacy state.json that has no processes field (backward compatible)", async () => {
		await withTempDir(async (dir) => {
			// Write a state object shaped like a pre-pid-persistence file.
			const legacy: LaunchState = initState("legacy", "name: legacy");
			// Ensure the field truly isn't present on disk.
			expect("processes" in legacy).toBe(false);
			await saveState(dir, legacy);

			const loaded = await loadState(dir);
			expect(loaded).not.toBeNull();
			expect(loaded?.processes).toBeUndefined();
			// `down` reads `state.processes ?? {}` — prove that defaulting works.
			expect(loaded?.processes ?? {}).toEqual({});
		});
	});
});

describe("state persistence of the publication context (D-58, #386)", () => {
	async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
		const dir = await mkdtemp(join(tmpdir(), "launchfile-state-"));
		try {
			return await fn(dir);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	it("round-trips appUrl and the primary endpoint's ports key together", async () => {
		await withTempDir(async (dir) => {
			const state = initState("my-app", "name: my-app");
			state.appUrl = "https://notes.example.com";
			state.primaryEndpoint = "web";
			await saveState(dir, state);

			const loaded = await loadState(dir);
			expect(loaded?.appUrl).toBe("https://notes.example.com");
			expect(loaded?.primaryEndpoint).toBe("web");
		});
	});

	it("loads a state.json without a primaryEndpoint key (every key prints localhost)", async () => {
		await withTempDir(async (dir) => {
			const state = initState("my-app", "name: my-app");
			expect("primaryEndpoint" in state).toBe(false);
			await saveState(dir, state);

			const loaded = await loadState(dir);
			expect(loaded?.primaryEndpoint).toBeUndefined();
		});
	});
});

describe("state persistence of env-level generator values (D-49, #186)", () => {
	async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
		const dir = await mkdtemp(join(tmpdir(), "launchfile-state-"));
		try {
			return await fn(dir);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	afterEach(() => {
		clearRegisteredSecrets();
	});

	it("round-trips the generatedEnv store", async () => {
		await withTempDir(async (dir) => {
			const state = initState("my-app", "name: my-app");
			state.generatedEnv = { "default.APP_KEY": "b".repeat(64) };
			await saveState(dir, state);

			const loaded = await loadState(dir);
			expect(loaded?.generatedEnv).toEqual({ "default.APP_KEY": "b".repeat(64) });
		});
	});

	it("loads a state.json without a generatedEnv key and behaves as a first run", async () => {
		await withTempDir(async (dir) => {
			const legacy: LaunchState = initState("legacy", "name: legacy");
			expect("generatedEnv" in legacy).toBe(false);
			await saveState(dir, legacy);

			const loaded = await loadState(dir);
			expect(loaded).not.toBeNull();
			expect(loaded?.generatedEnv).toBeUndefined();
			// Every reader defaults with `?? {}` — an empty store means "mint".
			expect(loaded?.generatedEnv ?? {}).toEqual({});
		});
	});

	it("registers reloaded generatedEnv values with the redactor (D-18)", async () => {
		await withTempDir(async (dir) => {
			const value = "c".repeat(64);
			const state = initState("my-app", "name: my-app");
			state.generatedEnv = { "default.APP_KEY": value };
			await saveState(dir, state);

			// A second process reuses (never re-mints) the value, so nothing but
			// the loader can make it scrubbable in that process.
			clearRegisteredSecrets();
			await loadState(dir);
			expect(redactSecrets(`token=${value}`)).toBe(`token=${REDACTED}`);
		});
	});
});

describe("ensureDirs (issue #252, CWE-276)", () => {
	async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
		const dir = await mkdtemp(join(tmpdir(), "launchfile-state-"));
		try {
			return await fn(dir);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	it("tightens a pre-existing .launchfile/env left at 0o755 to 0o700", async () => {
		await withTempDir(async (dir) => {
			const envDir = join(dir, ".launchfile", "env");
			await mkdir(envDir, { recursive: true });
			await chmod(envDir, 0o755);
			expect((await stat(envDir)).mode & 0o777).toBe(0o755);

			await ensureDirs(dir);

			expect((await stat(envDir)).mode & 0o777).toBe(0o700);
		});
	});

	it("creates all five state dirs at 0o700", async () => {
		await withTempDir(async (dir) => {
			await ensureDirs(dir);

			for (const d of ["storage", "tmp", "logs", "data", "env"]) {
				expect((await stat(join(dir, ".launchfile", d))).mode & 0o777).toBe(0o700);
			}
		});
	});
});

describe("load-boundary validation (#261)", () => {
	let dir: string;
	let warnings: string[];

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "launchfile-state-"));
		warnings = [];
		vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearRegisteredSecrets();
		await rm(dir, { recursive: true, force: true });
	});

	/** Write a raw state file, bypassing `saveState`'s typing. */
	async function writeRawState(body: unknown): Promise<string> {
		await mkdir(join(dir, ".launchfile"), { recursive: true });
		const file = join(dir, ".launchfile", "state.json");
		await writeFile(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
		return file;
	}

	const postgres = {
		type: "postgres",
		name: "postgres",
		port: 5432,
		dbName: "launchfile_app",
		user: "launchfile_app",
		password: "c2VjcmV0LXBhc3N3b3Jk",
	};
	const redis = { type: "redis", name: "redis", port: 6379 };
	const web = {
		pid: 1234,
		pgid: 1234,
		startedAt: "2026-06-18T00:00:00.000Z",
		command: "sh -c 'bun start'",
	};
	const worker = { ...web, pid: 1235, pgid: 1235 };

	const wellFormed = {
		version: 1,
		appName: "app",
		launchfileHash: "deadbeefdeadbeef",
		createdAt: "2026-06-18T00:00:00.000Z",
		updatedAt: "2026-06-18T00:00:00.000Z",
		resources: { postgres, redis },
		secrets: { API_KEY: "s3cret" },
		ports: { web: 3000, worker: 3001 },
		processes: { web, worker },
	};

	it("loads a well-formed file unchanged and warns about nothing", async () => {
		await writeRawState(wellFormed);
		const loaded = await loadState(dir);
		expect(loaded).toEqual(wellFormed);
		expect(warnings).toEqual([]);
	});

	it("drops a resource whose dbName is not a safe SQL identifier and keeps the rest", async () => {
		const file = await writeRawState({
			...wellFormed,
			resources: { postgres: { ...postgres, dbName: "app; DROP DATABASE prod" }, redis },
		});

		const loaded = await loadState(dir);
		expect(loaded?.resources).toEqual({ redis });
		expect(loaded?.processes).toEqual({ web, worker });
		expect(loaded?.secrets).toEqual({ API_KEY: "s3cret" });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(file);
		expect(warnings[0]).toContain("resources.postgres");
		expect(warnings[0]).toContain("dbName");
	});

	it("drops a resource whose user fails the identifier check", async () => {
		await writeRawState({
			...wellFormed,
			resources: { postgres: { ...postgres, user: "app'--" }, redis },
		});
		const loaded = await loadState(dir);
		expect(loaded?.resources).toEqual({ redis });
		expect(warnings[0]).toContain("resources.postgres (user");
	});

	it("drops a resource whose password is not base64url without echoing it", async () => {
		await writeRawState({
			...wellFormed,
			resources: { postgres: { ...postgres, password: "pw' OR 1=1 --" }, redis },
		});
		const loaded = await loadState(dir);
		expect(loaded?.resources).toEqual({ redis });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("resources.postgres (password");
		expect(warnings[0]).not.toContain("OR 1=1");
	});

	it("drops a resource with an out-of-range port and keeps its sibling", async () => {
		await writeRawState({
			...wellFormed,
			resources: { postgres: { ...postgres, port: 70000 }, redis },
		});
		const loaded = await loadState(dir);
		expect(loaded?.resources).toEqual({ redis });
		expect(warnings[0]).toContain("resources.postgres (port");
	});

	it("drops a ports entry that is not an integer in 1-65535 and keeps the rest", async () => {
		await writeRawState({
			...wellFormed,
			ports: { web: 3000, worker: 0, other: 3000.5, last: "3000" },
		});
		const loaded = await loadState(dir);
		expect(loaded?.ports).toEqual({ web: 3000 });
		expect(warnings.map((w) => w.match(/ignoring (\S+)/)?.[1])).toEqual([
			"ports.worker",
			"ports.other",
			"ports.last",
		]);
	});

	it("drops a process whose startedAt is more than a minute in the future and keeps its sibling", async () => {
		const file = await writeRawState({
			...wellFormed,
			processes: { web: { ...web, startedAt: "2999-01-01T00:00:00.000Z" }, worker },
		});
		const loaded = await loadState(dir);
		expect(loaded?.processes).toEqual({ worker });
		expect(loaded?.resources).toEqual({ postgres, redis });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(file);
		expect(warnings[0]).toContain(
			"processes.web (startedAt is more than a minute in the future)",
		);
	});

	it("keeps a process whose startedAt is 5 seconds ahead of the clock", async () => {
		const ahead = {
			...web,
			startedAt: new Date(Date.now() + 5_000).toISOString(),
		};
		await writeRawState({ ...wellFormed, processes: { web: ahead, worker } });
		const loaded = await loadState(dir);
		expect(loaded?.processes).toEqual({ web: ahead, worker });
		expect(warnings).toHaveLength(0);
	});

	it("drops a process whose startedAt does not parse", async () => {
		await writeRawState({
			...wellFormed,
			processes: { web: { ...web, startedAt: "yesterday" }, worker },
		});
		const loaded = await loadState(dir);
		expect(loaded?.processes).toEqual({ worker });
		expect(warnings[0]).toContain("processes.web (startedAt is not a parseable timestamp)");
	});

	it("drops a process whose pgid is not a positive integer", async () => {
		await writeRawState({
			...wellFormed,
			processes: { web: { ...web, pgid: 12.5 }, worker, zero: { ...web, pgid: 0 }, neg: { ...web, pgid: -1 } },
		});
		const loaded = await loadState(dir);
		expect(loaded?.processes).toEqual({ worker });
		expect(warnings.map((w) => w.match(/ignoring (\S+)/)?.[1])).toEqual([
			"processes.web",
			"processes.zero",
			"processes.neg",
		]);
	});

	it("drops a process whose pid is not a positive integer or whose command is not a string", async () => {
		await writeRawState({
			...wellFormed,
			processes: { web: { ...web, pid: "1234" }, worker: { ...worker, command: ["sh"] } },
		});
		const loaded = await loadState(dir);
		expect(loaded?.processes).toEqual({});
		expect(warnings).toHaveLength(2);
	});

	it("drops a non-string secret and keeps its siblings", async () => {
		await writeRawState({ ...wellFormed, secrets: { API_KEY: "s3cret", BAD: 42 } });
		const loaded = await loadState(dir);
		expect(loaded?.secrets).toEqual({ API_KEY: "s3cret" });
		expect(warnings[0]).toContain("secrets.BAD");
	});

	it("drops a processes field that is not an object and keeps everything else", async () => {
		await writeRawState({ ...wellFormed, processes: [web] });
		const loaded = await loadState(dir);
		expect(loaded?.processes).toBeUndefined();
		expect(loaded?.resources).toEqual({ postgres, redis });
		expect(warnings[0]).toContain("processes (not an object)");
	});

	it("drops an optional top-level field of the wrong type and keeps the rest", async () => {
		await writeRawState({ ...wellFormed, appUrl: 42, launchfileHash: null });
		const loaded = await loadState(dir);
		expect(loaded?.appUrl).toBeUndefined();
		expect(loaded?.launchfileHash).toBeUndefined();
		expect(loaded?.appName).toBe("app");
		expect(warnings.map((w) => w.match(/ignoring (\S+)/)?.[1])).toEqual([
			"launchfileHash",
			"appUrl",
		]);
	});

	it("keeps an unknown key through a loadState → saveState round trip", async () => {
		// A field a newer provider version writes must survive an older one,
		// which cannot know what it means (P-13) — at the top level and inside
		// an entry.
		await writeRawState({
			...wellFormed,
			futureField: { nested: true },
			resources: { redis: { ...redis, futureRedisField: "x" } },
		});

		const loaded = await loadState(dir);
		expect(loaded).not.toBeNull();
		if (loaded === null) return;
		expect((loaded as unknown as Record<string, unknown>).futureField).toEqual({ nested: true });
		expect(warnings).toEqual([]);

		await saveState(dir, loaded);
		const onDisk = JSON.parse(await readFile(join(dir, ".launchfile", "state.json"), "utf8"));
		expect(onDisk.futureField).toEqual({ nested: true });
		expect(onDisk.resources.redis.futureRedisField).toBe("x");
		expect(onDisk.appName).toBe("app");
	});

	it("returns null with one warning naming the field when the envelope is unusable", async () => {
		const file = await writeRawState({ ...wellFormed, resources: "none" });
		expect(await loadState(dir)).toBeNull();
		expect(warnings).toEqual([`  Warning: ${file}: ignoring state (resources is not an object)`]);

		warnings.length = 0;
		const { appName: _dropped, ...noAppName } = wellFormed;
		await writeRawState(noAppName);
		expect(await loadState(dir)).toBeNull();
		expect(warnings).toEqual([`  Warning: ${file}: ignoring state (appName is not a string)`]);
	});

	it("returns null for a JSON document that is not an object", async () => {
		await writeRawState("[1, 2, 3]");
		expect(await loadState(dir)).toBeNull();
		expect(warnings[0]).toContain("not a JSON object");
	});

	it("returns null, and never throws, for unparseable bytes and for a missing file", async () => {
		await writeRawState("{ not json");
		expect(await loadState(dir)).toBeNull();
		await rm(join(dir, ".launchfile"), { recursive: true, force: true });
		expect(await loadState(dir)).toBeNull();
	});

	it("still registers the surviving secrets and resource passwords with the redactor (D-18)", async () => {
		const apiKey = "k".repeat(32);
		await writeRawState({
			...wellFormed,
			resources: { postgres, bad: { ...postgres, dbName: "x;y" } },
			secrets: { API_KEY: apiKey, BAD: 42 },
		});
		await loadState(dir);
		expect(redactSecrets(`key=${apiKey}`)).toBe(`key=${REDACTED}`);
		expect(redactSecrets(`pw=${postgres.password}`)).toBe(`pw=${REDACTED}`);
	});
});
