import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLaunchErrorContext, type LaunchErrorContext } from "@launchfile/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { handleDiagnose, renderDiagnosis } from "../commands/diagnose.js";
import {
	clearLaunchErrorRecord,
	errorRecordPath,
	errorsDir,
	lastPointerPath,
	readLastPointer,
	readLaunchErrorRecord,
	safeKey,
	writeLaunchErrorRecord,
} from "../state/errors.js";

const IDENTITY = (s: string): string => s;

// The directory is injected rather than faked through $HOME: Bun's os.homedir()
// ignores the variable, so an env override would silently write to the real one.
let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "lf-errors-"));
});

function context(overrides: Partial<Parameters<typeof buildLaunchErrorContext>[0]> = {}): LaunchErrorContext {
	return buildLaunchErrorContext(
		{
			phase: "release",
			provider: "docker",
			key: "demo",
			app: "demo",
			slug: "demo",
			message: "release [web] failed with exit code 1",
			...overrides,
		},
		IDENTITY,
	);
}

describe("errorsDir", () => {
	it("lives beside the rest of the launchfile state", () => {
		expect(errorsDir().endsWith(join(".launchfile", "errors"))).toBe(true);
	});
});

describe("safeKey", () => {
	it("reduces a key to one path segment", () => {
		expect(safeKey("ghost")).toBe("ghost");
		expect(safeKey("src-0123abcd")).toBe("src-0123abcd");
	});

	it("refuses to let a key traverse out of the errors directory (CWE-22)", () => {
		// Every separator is gone, so the result is one segment and cannot escape.
		expect(safeKey("../../.ssh/id_rsa")).toBe(".._.._.ssh_id_rsa");
		expect(safeKey("..")).toBe("_");
		expect(safeKey(".")).toBe("_");
		expect(safeKey("/etc/passwd")).toBe("_etc_passwd");
		expect(safeKey("")).toBe("_");
		expect(safeKey("a".repeat(500))).toHaveLength(96);
	});
});

describe("writeLaunchErrorRecord", () => {
	it("writes the record 0600 inside a 0700 directory (§D, CWE-276)", async () => {
		const path = await writeLaunchErrorRecord(context(), dir);

		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(dir)).mode & 0o777).toBe(0o700);
		expect((await stat(lastPointerPath(dir))).mode & 0o777).toBe(0o600);
	});

	it("tightens a pre-existing errors directory that is too open", async () => {
		await mkdir(dir, { recursive: true, mode: 0o755 });
		await writeLaunchErrorRecord(context(), dir);
		expect((await stat(dir)).mode & 0o777).toBe(0o700);
	});

	it("points last.json at the record it just wrote", async () => {
		await writeLaunchErrorRecord(context(), dir);
		const pointer = await readLastPointer(dir);
		expect(pointer?.key).toBe("demo");
		expect(pointer?.path).toBe(errorRecordPath("demo", dir));
	});

	it("keeps two apps' failures independently retrievable (multi-app isolation)", async () => {
		// The test a single global last-error.json would fail.
		await writeLaunchErrorRecord(context({ key: "app-one", app: "app-one", message: "one broke" }), dir);
		await writeLaunchErrorRecord(context({ key: "app-two", app: "app-two", message: "two broke" }), dir);

		expect((await readLaunchErrorRecord("app-one", dir))?.message).toBe("one broke");
		expect((await readLaunchErrorRecord("app-two", dir))?.message).toBe("two broke");
		// A bare read follows the pointer to the most recent one.
		expect((await readLaunchErrorRecord(undefined, dir))?.key).toBe("app-two");
	});
});

describe("readLaunchErrorRecord", () => {
	it("returns null when nothing has failed", async () => {
		expect(await readLaunchErrorRecord(undefined, dir)).toBeNull();
		expect(await readLaunchErrorRecord("nope", dir)).toBeNull();
	});

	it("rejects a file that is not a launch-error record", async () => {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(errorRecordPath("junk", dir), '{"hello":"world"}\n');
		expect(await readLaunchErrorRecord("junk", dir)).toBeNull();
	});

	it("round-trips every captured field", async () => {
		const written = context({
			stderr: "FATAL: relation does not exist",
			command: "psql -f migrate.sql",
			exitCode: 1,
			serviceLogs: { compose: "web-1  | crashed" },
			env: { DATABASE_URL: "postgres://u:p@h/db", PORT: "3000" },
			warnings: ["reaper: declares a schedule"],
		});
		await writeLaunchErrorRecord(written, dir);

		const read = await readLaunchErrorRecord("demo", dir);
		expect(read).toEqual(written);
		expect(read?.envKeys).toEqual(["DATABASE_URL", "PORT"]);
		// The record on disk holds names, never values.
		expect(await readFile(errorRecordPath("demo", dir), "utf8")).not.toContain("postgres://u:p@h/db");
	});
});

describe("supersession (§H)", () => {
	it("clears the record and the pointer that named it", async () => {
		await writeLaunchErrorRecord(context({ key: "demo" }), dir);
		await clearLaunchErrorRecord("demo", dir);

		expect(await readLaunchErrorRecord("demo", dir)).toBeNull();
		expect(await readLastPointer(dir)).toBeNull();
	});

	it("leaves another app's pointer alone", async () => {
		await writeLaunchErrorRecord(context({ key: "app-one" }), dir);
		await writeLaunchErrorRecord(context({ key: "app-two" }), dir);
		await clearLaunchErrorRecord("app-one", dir);

		expect(await readLaunchErrorRecord("app-one", dir)).toBeNull();
		expect((await readLastPointer(dir))?.key).toBe("app-two");
	});

	it("is a no-op when there is nothing to clear", async () => {
		await expect(clearLaunchErrorRecord("never-existed", dir)).resolves.toBeUndefined();
	});
});

describe("launchfile diagnose", () => {
	function capture(): { io: { out: (s: string) => void; err: (s: string) => void }; stdout: string[]; stderr: string[] } {
		const stdout: string[] = [];
		const stderr: string[] = [];
		return { io: { out: (s) => stdout.push(s), err: (s) => stderr.push(s) }, stdout, stderr };
	}

	it("exits non-zero with a clear message and no stack trace when nothing failed", async () => {
		const { io, stdout, stderr } = capture();
		const code = await handleDiagnose(undefined, {}, io, dir);

		expect(code).toBe(1);
		expect(stdout).toEqual([]);
		expect(stderr.join("")).toContain("No captured launch failure");
		expect(stderr.join("")).not.toContain("    at ");
	});

	it("puts parseable JSON and nothing else on stdout with --json", async () => {
		await writeLaunchErrorRecord(context({ stderr: "boom", exitCode: 1 }), dir);
		const { io, stdout, stderr } = capture();

		const code = await handleDiagnose(undefined, { json: true }, io, dir);

		expect(code).toBe(0);
		expect(stderr).toEqual([]);
		const parsed = JSON.parse(stdout.join("")) as LaunchErrorContext;
		expect(parsed.phase).toBe("release");
		expect(parsed.disposition).toBe("failed-deploy");
	});

	it("reports a named record", async () => {
		await writeLaunchErrorRecord(context({ key: "other", app: "other", message: "other broke" }), dir);
		await writeLaunchErrorRecord(context({ key: "demo" }), dir);

		const { io, stdout } = capture();
		expect(await handleDiagnose("other", {}, io, dir)).toBe(0);
		expect(stdout.join("")).toContain("other broke");
	});

	it("says so when a named app has no record", async () => {
		const { io, stderr } = capture();
		expect(await handleDiagnose("ghost", {}, io, dir)).toBe(1);
		expect(stderr.join("")).toContain('No captured launch failure for "ghost"');
	});
});

describe("renderDiagnosis", () => {
	it("names the phase, the D-48 disposition, and the record", () => {
		const text = renderDiagnosis(
			context({ command: "psql -f migrate.sql", exitCode: 1, stderr: "relation missing" }),
		);

		expect(text).toContain("failed during release slot");
		expect(text).toContain("failed the deploy");
		expect(text).toContain("psql -f migrate.sql");
		expect(text).toContain("relation missing");
		expect(text).toContain("~/.launchfile/errors/demo.json");
	});

	it("says a bootstrap failure did not affect deploy status (D-48)", () => {
		const text = renderDiagnosis(context({ phase: "bootstrap", key: "demo" }));
		expect(text).toContain("failed during bootstrap slot");
		expect(text).toContain("deploy status is unaffected");
	});

	it("lists env names without ever having a value to list", () => {
		const text = renderDiagnosis(context({ env: { API_KEY: "sentinel-9911", PORT: "3000" } }));
		expect(text).toContain("Declared env variables: API_KEY, PORT");
		expect(text).not.toContain("sentinel-9911");
	});
});
