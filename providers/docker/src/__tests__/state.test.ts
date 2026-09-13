import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	initState,
	saveState,
	loadState,
	loadDockerSource,
	hashLaunchfile,
	stateDir,
	composeProject,
	type DockerState,
} from "../state.js";
import { dockerUp } from "../provider.js";
import { logger } from "../logger.js";
import { clearRegisteredSecrets, redactSecrets, REDACTED } from "../redact.js";

// state.ts keys everything off homedir() → ~/.launchfile/docker/<slug>.
// node:os.homedir() honors $HOME on POSIX, so redirect it to a temp dir to
// keep the real ~/.launchfile untouched.
let prevHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
	prevHome = process.env.HOME;
	tmpHome = mkdtempSync(join(tmpdir(), "lf-docker-state-"));
	process.env.HOME = tmpHome;
});

afterEach(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("docker state — source persistence (#25)", () => {
	it("round-trips sourcePath/sourceType for a local source", async () => {
		const state = initState("cool-app", "cool-app", "name: cool-app\n", {
			sourceType: "local",
			sourcePath: "/Users/me/code/myrepo/Launchfile",
		});
		await saveState("cool-app", state);

		const loaded = await loadState("cool-app");
		expect(loaded).not.toBeNull();
		expect(loaded!.sourceType).toBe("local");
		expect(loaded!.sourcePath).toBe("/Users/me/code/myrepo/Launchfile");
	});

	it("records the catalog slug and sourceType for catalog sources", async () => {
		const state = initState("ghost", "ghost", "name: ghost\n", {
			sourceType: "catalog",
		});
		await saveState("ghost", state);

		const src = await loadDockerSource("ghost");
		expect(src).not.toBeNull();
		expect(src!.slug).toBe("ghost");
		expect(src!.sourceType).toBe("catalog");
		// No on-disk path for catalog sources — re-resolve from the slug.
		expect(src!.sourcePath).toBeUndefined();
	});

	it("records the URL for url sources", async () => {
		const state = initState("remote", "remote", "name: remote\n", {
			sourceType: "url",
			sourceUrl: "https://example.com/Launchfile",
		});
		await saveState("remote", state);

		const src = await loadDockerSource("remote");
		expect(src!.sourceType).toBe("url");
		expect(src!.sourceUrl).toBe("https://example.com/Launchfile");
	});

	it("loadDockerSource returns null when no state exists", async () => {
		expect(await loadDockerSource("nope")).toBeNull();
	});
});

describe("docker state — publication context (#290)", () => {
	it("round-trips appUrl", async () => {
		const state = initState("proxied", "proxied", "name: proxied\n");
		state.appUrl = "https://notes.example.com";
		await saveState("proxied", state);

		const loaded = await loadState("proxied");
		expect(loaded).not.toBeNull();
		expect(loaded!.appUrl).toBe("https://notes.example.com");
	});

	it("loads a state file without an appUrl key (localhost routing stands)", async () => {
		const state = initState("plain", "plain", "name: plain\n");
		expect("appUrl" in state).toBe(false);
		await saveState("plain", state);

		const loaded = await loadState("plain");
		expect(loaded).not.toBeNull();
		expect(loaded!.appUrl).toBeUndefined();
	});
});

describe("docker state — backward compatibility", () => {
	it("loads a legacy state file that lacks the new source fields", async () => {
		// Simulate a state.json written before source persistence landed.
		const legacy: DockerState = {
			version: 1,
			slug: "legacy",
			appName: "legacy",
			composeProject: "launchfile-legacy",
			launchfileHash: "deadbeef",
			createdAt: "2024-01-01T00:00:00.000Z",
			updatedAt: "2024-01-01T00:00:00.000Z",
			secrets: {},
			ports: { default: 3000 },
		};
		const dir = stateDir("legacy");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "state.json"), JSON.stringify(legacy, null, 2));

		const loaded = await loadState("legacy");
		expect(loaded).not.toBeNull();
		// New fields are absent but loading does not throw.
		expect(loaded!.sourceType).toBeUndefined();
		expect(loaded!.sourcePath).toBeUndefined();

		const src = await loadDockerSource("legacy");
		expect(src).not.toBeNull();
		expect(src!.slug).toBe("legacy");
		expect(src!.sourcePath).toBeUndefined();
	});

	it("loads a state file without a generatedEnv key and behaves as a first run (D-49)", async () => {
		const state = initState("older", "older", "name: older\n");
		expect("generatedEnv" in state).toBe(false);
		await saveState("older", state);

		const loaded = await loadState("older");
		expect(loaded).not.toBeNull();
		expect(loaded!.generatedEnv).toBeUndefined();
		// launchToCompose defaults with `?? {}` — an empty store means "mint".
		expect(loaded!.generatedEnv ?? {}).toEqual({});
	});
});

describe("docker state — env-level generator values (D-49, #186)", () => {
	afterEach(() => {
		clearRegisteredSecrets();
	});

	it("round-trips the generatedEnv store", async () => {
		const state = initState("envgen", "envgen", "name: envgen\n");
		state.generatedEnv = { "default.APP_KEY": "b".repeat(64) };
		await saveState("envgen", state);

		const loaded = await loadState("envgen");
		expect(loaded!.generatedEnv).toEqual({ "default.APP_KEY": "b".repeat(64) });
	});

	it("registers reloaded generatedEnv values with the redactor (D-18)", async () => {
		const value = "c".repeat(64);
		const state = initState("envgen", "envgen", "name: envgen\n");
		state.generatedEnv = { "default.APP_KEY": value };
		await saveState("envgen", state);

		// A second process reuses (never re-mints) the value, so nothing but
		// the loader can make it scrubbable in that process.
		clearRegisteredSecrets();
		await loadState("envgen");
		expect(redactSecrets(`token=${value}`)).toBe(`token=${REDACTED}`);
	});
});

describe("docker state — composeProject slug guard", () => {
	it("prefixes a well-formed slug", () => {
		expect(composeProject("cool-app")).toBe("launchfile-cool-app");
		expect(composeProject("a")).toBe("launchfile-a");
		expect(composeProject(`a${"b".repeat(62)}`)).toBe(`launchfile-a${"b".repeat(62)}`);
	});

	it("normalizes case and whitespace before validating", () => {
		expect(composeProject("APP")).toBe("launchfile-app");
		expect(composeProject(" app ")).toBe("launchfile-app");
	});

	it("rejects a slug that could reach docker as anything but a project name", () => {
		// The name travels as its own argv element, so none of these are
		// interpreted today — the guard is what keeps that true (CWE-78).
		for (const bad of [
			"app;rm -rf /",
			"app $(id)",
			"app`id`",
			"../escape",
			"app name",
			"-p",
			"",
			`a${"b".repeat(63)}`,
		]) {
			expect(() => composeProject(bad)).toThrow(/Invalid slug/);
		}
	});
});

/**
 * Load-boundary validation (#441). `loadState` parses a file an operator can
 * hand-edit, so every field is checked at run time. A bad key is dropped and
 * the rest of the file is kept: the file records a deployment whose containers
 * are still running, and discarding all of it would orphan them.
 */
describe("docker state — load-boundary validation (#441)", () => {
	/** Write a raw state file for `slug`, bypassing `saveState`'s typing. */
	function writeRawState(slug: string, body: unknown): string {
		const dir = stateDir(slug);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "state.json");
		writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
		return file;
	}

	const wellFormed = {
		version: 1,
		slug: "app",
		appName: "app",
		composeProject: "launchfile-app",
		launchfileHash: "deadbeefdeadbeef",
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		secrets: { DB_PASSWORD: "s3cret" },
		ports: { default: 3000 },
	};

	let warn: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined) as ReturnType<typeof vi.fn>;
	});

	afterEach(() => {
		warn.mockRestore();
		clearRegisteredSecrets();
	});

	/** The `key` field of every warning the load emitted. */
	const warnedKeys = (): unknown[] =>
		warn.mock.calls.map((call: unknown[]) => (call[0] as { key?: unknown } | undefined)?.key);

	it("defaults a missing ports map to an empty object and warns", async () => {
		const { ports: _dropped, ...noPorts } = wellFormed;
		const file = writeRawState("app", noPorts);

		const loaded = await loadState("app");
		expect(loaded).not.toBeNull();
		// This is the crash the issue reports: status/list read
		// Object.keys(state.ports) with no guard.
		expect(loaded!.ports).toEqual({});
		expect(() => Object.keys(loaded!.ports)).not.toThrow();
		expect(warnedKeys()).toContain("ports");
		expect(warn.mock.calls[0]?.[0]).toMatchObject({ stateFile: file });
	});

	it("defaults a ports map that is not an object and warns", async () => {
		writeRawState("app", { ...wellFormed, ports: "3000" });

		const loaded = await loadState("app");
		expect(loaded!.ports).toEqual({});
		expect(warnedKeys()).toContain("ports");
	});

	it("drops a port entry that is not a number and keeps the rest", async () => {
		writeRawState("app", { ...wellFormed, ports: { default: 3000, admin: "2368" } });

		const loaded = await loadState("app");
		expect(loaded!.ports).toEqual({ default: 3000 });
		expect(warnedKeys()).toContain("ports.admin");
	});

	it("drops a secrets field that is not an object and keeps every other field", async () => {
		writeRawState("app", { ...wellFormed, secrets: "DB_PASSWORD=s3cret" });

		const loaded = await loadState("app");
		expect(loaded).not.toBeNull();
		expect(loaded!.secrets).toBeUndefined();
		expect(loaded!.appName).toBe("app");
		expect(loaded!.ports).toEqual({ default: 3000 });
		expect(warnedKeys()).toContain("secrets");
	});

	it("drops a single non-string secret and keeps its siblings", async () => {
		writeRawState("app", {
			...wellFormed,
			secrets: { DB_PASSWORD: "s3cret", PORT: 5432 },
		});

		const loaded = await loadState("app");
		expect(loaded!.secrets).toEqual({ DB_PASSWORD: "s3cret" });
		expect(warnedKeys()).toContain("secrets.PORT");
	});

	it("drops a single non-string resource password and keeps its siblings", async () => {
		writeRawState("app", {
			...wellFormed,
			resourcePasswords: { "db.postgres": "pgpass", "cache.redis": null },
		});

		const loaded = await loadState("app");
		expect(loaded!.resourcePasswords).toEqual({ "db.postgres": "pgpass" });
		expect(loaded!.secrets).toEqual({ DB_PASSWORD: "s3cret" });
		expect(warnedKeys()).toContain("resourcePasswords.cache.redis");
	});

	it("loads a file whose required appName is absent, warning about nothing else", async () => {
		const { appName: _absent, ...noName } = wellFormed;
		writeRawState("app", noName);

		const loaded = await loadState("app");
		expect(loaded).not.toBeNull();
		expect(loaded!.appName).toBeUndefined();
		// An absent field is not a malformed one — nothing is dropped.
		expect(warn).not.toHaveBeenCalled();
		expect(loaded!.slug).toBe("app");
		expect(loaded!.ports).toEqual({ default: 3000 });
	});

	it("drops a required field of the wrong type and keeps the rest", async () => {
		writeRawState("app", { ...wellFormed, appName: 42, version: "1" });

		const loaded = await loadState("app");
		expect(loaded!.appName).toBeUndefined();
		expect(loaded!.version).toBeUndefined();
		expect(loaded!.slug).toBe("app");
		expect(warnedKeys()).toEqual(expect.arrayContaining(["appName", "version"]));
	});

	it("drops a malformed endpoint entry and keeps the well-formed one", async () => {
		writeRawState("app", {
			...wellFormed,
			ports: { default: 3000, admin: 2368 },
			endpoints: {
				default: { component: "web", containerPort: 80, hostPort: 3000, protocol: "https" },
				admin: { component: "web", containerPort: "2368", hostPort: 2368 },
			},
		});

		const loaded = await loadState("app");
		expect(Object.keys(loaded!.endpoints ?? {})).toEqual(["default"]);
		expect(loaded!.endpoints?.default?.protocol).toBe("https");
		expect(warnedKeys()).toContain("endpoints.admin");
	});

	it("keeps an unknown key through a load-and-save round trip", async () => {
		// A field a newer provider version writes must survive an older one,
		// which cannot know what it means (P-13).
		writeRawState("app", { ...wellFormed, futureField: { nested: true } });

		const loaded = await loadState("app");
		expect((loaded as unknown as Record<string, unknown>).futureField).toEqual({
			nested: true,
		});

		await saveState("app", loaded!);
		const onDisk = JSON.parse(
			readFileSync(join(stateDir("app"), "state.json"), "utf8"),
		) as Record<string, unknown>;
		expect(onDisk.futureField).toEqual({ nested: true });
		expect(onDisk.slug).toBe("app");
	});

	it("returns null for a JSON document that is not an object", async () => {
		writeRawState("app", "[1, 2, 3]");
		expect(await loadState("app")).toBeNull();
	});

	it("returns null for unparseable bytes and for a missing file", async () => {
		writeRawState("app", "{not json");
		expect(await loadState("app")).toBeNull();
		expect(await loadState("never-deployed")).toBeNull();
	});

	it("never throws on a malformed file", async () => {
		for (const body of ["null", '"a string"', "{}", '{"ports": []}', '{"secrets": null}']) {
			writeRawState("wild", body);
			await expect(loadState("wild")).resolves.not.toThrow();
		}
	});

	it("still registers reloaded secrets with the redactor after validation (D-18)", async () => {
		const value = "d".repeat(64);
		writeRawState("app", { ...wellFormed, secrets: { DB_PASSWORD: value, BAD: 7 } });

		clearRegisteredSecrets();
		await loadState("app");
		expect(redactSecrets(`pw=${value}`)).toBe(`pw=${REDACTED}`);
	});

	it("still registers reloaded resource passwords with the redactor after validation (D-18)", async () => {
		const value = "e".repeat(64);
		writeRawState("app", {
			...wellFormed,
			resourcePasswords: { "db.postgres": value, BAD: 7 },
		});

		clearRegisteredSecrets();
		await loadState("app");
		expect(redactSecrets(`pw=${value}`)).toBe(`pw=${REDACTED}`);
	});
});

/**
 * The recorded `launchfileHash` is read on `up` (#441). It catches what the
 * D-55 rule 3 source guard cannot see: a Launchfile edited in place at the
 * same path. It warns and continues — refusing would break the
 * edit-then-redeploy cycle D-49 relies on.
 */
describe("docker state — launchfileHash is read on up (#441)", () => {
	const LAUNCHFILE = `version: launch/v1
name: hashtest
image: alpine:3.20
commands:
  start: sleep 300
`;

	let projectDir: string;
	let warnings: string[];
	let restore: (() => void) | null = null;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "lf-hash-app-"));
		writeFileSync(join(projectDir, "Launchfile"), LAUNCHFILE);
		warnings = [];
		const log = console.log;
		const err = console.error;
		const wrn = console.warn;
		console.log = () => undefined;
		console.error = (...args: unknown[]) => warnings.push(args.join(" "));
		console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
		restore = () => {
			console.log = log;
			console.error = err;
			console.warn = wrn;
		};
	});

	afterEach(() => {
		restore?.();
		restore = null;
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("hashes the Launchfile text it is given", () => {
		expect(hashLaunchfile(LAUNCHFILE)).toBe(hashLaunchfile(LAUNCHFILE));
		expect(hashLaunchfile(LAUNCHFILE)).not.toBe(hashLaunchfile(`${LAUNCHFILE}# edited\n`));
		expect(hashLaunchfile(LAUNCHFILE)).toMatch(/^[0-9a-f]{16}$/);
	});

	it("warns and continues when the recorded hash differs from the current file", async () => {
		const state = initState("hashtest", "hashtest", "name: something-else\n", {
			sourceType: "local",
			sourcePath: join(projectDir, "Launchfile"),
		});
		await saveState("hashtest", state);

		// A dry run reaches the comparison and writes nothing.
		const result = await dockerUp(projectDir, { dryRun: true });
		expect(result.slug).toBe("hashtest");
		const printed = warnings.join("\n");
		expect(printed).toContain("differs from the one this deployment was created from");
		expect(printed).toContain("hashtest");
		expect(printed).toContain(hashLaunchfile(LAUNCHFILE));
	});

	it("stays silent when the Launchfile is unchanged", async () => {
		const state = initState("hashtest", "hashtest", LAUNCHFILE, {
			sourceType: "local",
			sourcePath: join(projectDir, "Launchfile"),
		});
		await saveState("hashtest", state);

		await dockerUp(projectDir, { dryRun: true });
		expect(warnings.join("\n")).not.toContain("differs from the one");
	});

	it("stays silent on a first deployment, which has no recorded hash", async () => {
		await dockerUp(projectDir, { dryRun: true });
		expect(warnings.join("\n")).not.toContain("differs from the one");
	});
});
