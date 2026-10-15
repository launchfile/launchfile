/**
 * The confinement helpers every write under `.launchfile/` (and `.env.local`)
 * goes through (#655). `.launchfile/` ships with the cloned repository, so a
 * committed symlink there would otherwise send state, env files and logs to
 * wherever it points (CWE-59). The anchor is `realpath(projectDir)`; the
 * requested path is joined onto it lexically and never resolved itself.
 */

import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ConfinementRefusal,
	ensureConfinedDir,
	openConfinedFile,
	writeConfinedFile,
} from "../safe-path.js";

let projectDir: string;
let victimDir: string;

beforeEach(async () => {
	projectDir = await mkdtemp(join(tmpdir(), "lf-safe-path-"));
	victimDir = await mkdtemp(join(tmpdir(), "lf-safe-path-victim-"));
});

afterEach(async () => {
	await rm(projectDir, { recursive: true, force: true });
	await rm(victimDir, { recursive: true, force: true });
});

async function mode(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

describe("ensureConfinedDir", () => {
	it("creates the directory under the real project directory at the given mode", async () => {
		const created = await ensureConfinedDir(
			projectDir,
			[".launchfile", "env"],
			{ mode: 0o700 },
		);

		// tmpdir() is itself a symlink on macOS: a project under a symlinked
		// parent is allowed, and the anchor is its real path.
		expect(created).toBe(
			join(await realpath(projectDir), ".launchfile", "env"),
		);
		expect(await mode(join(projectDir, ".launchfile", "env"))).toBe(0o700);
	});

	it("tightens a directory an earlier version left at 0o755", async () => {
		const dir = join(projectDir, ".launchfile", "data");
		await mkdir(dir, { recursive: true });
		await chmod(dir, 0o755);

		await ensureConfinedDir(projectDir, [".launchfile", "data"], {
			mode: 0o700,
		});

		expect(await mode(dir)).toBe(0o700);
	});

	it("refuses when .launchfile is a symlink out of the project, naming the target", async () => {
		await symlink(victimDir, join(projectDir, ".launchfile"));

		const refusal = await ensureConfinedDir(
			projectDir,
			[".launchfile", "env"],
			{ mode: 0o700 },
		).then(
			() => null,
			(err: unknown) => err,
		);

		expect(refusal).toBeInstanceOf(ConfinementRefusal);
		const { path, reason, message } = refusal as ConfinementRefusal;
		expect(path).toBe(join(await realpath(projectDir), ".launchfile"));
		expect(reason).toBe(`is a symlink to ${victimDir}`);
		expect(message).toBe(
			`${path} is a symlink to ${victimDir}; refusing to write`,
		);
		expect(await readdir(victimDir)).toEqual([]);
	});

	it("escapes control characters in a symlink target before naming it", async () => {
		await symlink(
			"/tmp/x\nRefused: nothing\x1b[2K\\u000a",
			join(projectDir, ".launchfile"),
		);

		const refusal = await ensureConfinedDir(
			projectDir,
			[".launchfile", "env"],
			{ mode: 0o700 },
		).then(
			() => null,
			(err: unknown) => err,
		);

		expect(refusal).toBeInstanceOf(ConfinementRefusal);
		const { message } = refusal as ConfinementRefusal;
		expect(message).toContain(
			"is a symlink to /tmp/x\\u000aRefused: nothing\\u001b[2K\\\\u000a;",
		);
		const controls = Array.from(message).filter((c) => {
			const code = c.charCodeAt(0);
			return code < 0x20 || (code >= 0x7f && code <= 0x9f);
		});
		expect(controls).toEqual([]);
	});

	it("escapes control characters in a path component it refuses", async () => {
		// Storage volume keys are free-form strings that reach this helper as
		// parts, so a hostile key must not forge a terminal line either.
		const refusal = await ensureConfinedDir(
			projectDir,
			[".launchfile", "storage", "x/\n\x1b[2KStarted web on :3000"],
			{ mode: 0o700 },
		).then(
			() => null,
			(err: unknown) => err,
		);

		expect(refusal).toBeInstanceOf(ConfinementRefusal);
		const { message, path } = refusal as ConfinementRefusal;
		expect(message).toBe(
			"x/\\u000a\\u001b[2KStarted web on :3000 is not a single path component; refusing to write",
		);
		expect(path).toBe("x/\\u000a\\u001b[2KStarted web on :3000");
		const controls = Array.from(message).filter((c) => {
			const code = c.charCodeAt(0);
			return code < 0x20 || (code >= 0x7f && code <= 0x9f);
		});
		expect(controls).toEqual([]);
	});

	it("escapes control characters in the refused path itself", async () => {
		const hostileProject = join(projectDir, "gone\n\x1b[2K");

		const refusal = await ensureConfinedDir(hostileProject, [".launchfile"], {
			mode: 0o700,
		}).then(
			() => null,
			(err: unknown) => err,
		);

		expect(refusal).toBeInstanceOf(ConfinementRefusal);
		const { message } = refusal as ConfinementRefusal;
		expect(message).toContain("gone\\u000a\\u001b[2K does not exist;");
		const controls = Array.from(message).filter((c) => {
			const code = c.charCodeAt(0);
			return code < 0x20 || (code >= 0x7f && code <= 0x9f);
		});
		expect(controls).toEqual([]);
	});

	it("refuses when the leaf component is a symlink to a directory", async () => {
		// mkdir({ recursive: true }) succeeds through a symlink to a directory
		// and reports nothing.
		await mkdir(join(projectDir, ".launchfile"));
		await symlink(victimDir, join(projectDir, ".launchfile", "env"));

		await expect(
			ensureConfinedDir(projectDir, [".launchfile", "env"], { mode: 0o700 }),
		).rejects.toThrow("env is a symlink to");
		expect(await readdir(victimDir)).toEqual([]);
	});

	it("refuses when a component is a regular file", async () => {
		await mkdir(join(projectDir, ".launchfile"));
		await writeFile(join(projectDir, ".launchfile", "env"), "not a directory");

		await expect(
			ensureConfinedDir(projectDir, [".launchfile", "env"], { mode: 0o700 }),
		).rejects.toThrow("env is not a directory; refusing to write");
	});

	it("refuses a `..` part rather than resolving it", async () => {
		await expect(
			ensureConfinedDir(projectDir, ["..", "elsewhere"], { mode: 0o700 }),
		).rejects.toThrow(".. is not a single path component; refusing to write");
	});

	it("refuses a part that carries a path separator", async () => {
		await expect(
			ensureConfinedDir(projectDir, [".launchfile/env"], { mode: 0o700 }),
		).rejects.toThrow(
			".launchfile/env is not a single path component; refusing to write",
		);
		await expect(readdir(projectDir)).resolves.toEqual([]);
	});

	it("refuses when the project directory does not exist", async () => {
		const missing = join(projectDir, "missing");

		await expect(
			ensureConfinedDir(missing, [".launchfile"], { mode: 0o700 }),
		).rejects.toThrow(`${missing} does not exist; refusing to write`);
	});
});

describe("writeConfinedFile", () => {
	it("writes the file at its mode and the parent at dirMode", async () => {
		await writeConfinedFile(projectDir, [".launchfile", "state.json"], "{}\n", {
			mode: 0o600,
			dirMode: 0o700,
		});

		expect(
			await readFile(join(projectDir, ".launchfile", "state.json"), "utf8"),
		).toBe("{}\n");
		expect(await mode(join(projectDir, ".launchfile", "state.json"))).toBe(
			0o600,
		);
		expect(await mode(join(projectDir, ".launchfile"))).toBe(0o700);
	});

	it("replaces the content and tightens a file an earlier version left at 0o644", async () => {
		const file = join(projectDir, ".env.local");
		await writeFile(file, "OLD=1\nOLDER=2\n");
		await chmod(file, 0o644);

		await writeConfinedFile(projectDir, [".env.local"], "NEW=1\n", {
			mode: 0o600,
		});

		expect(await readFile(file, "utf8")).toBe("NEW=1\n");
		expect(await mode(file)).toBe(0o600);
	});

	it("leaves the project directory's own mode alone when writing directly under it", async () => {
		await chmod(projectDir, 0o755);

		await writeConfinedFile(projectDir, [".env.local"], "A=1\n", {
			mode: 0o600,
			dirMode: 0o700,
		});

		expect(await mode(projectDir)).toBe(0o755);
	});

	it("refuses when the file is a symlink out of the project and leaves the target untouched", async () => {
		const victim = join(victimDir, "sink");
		await writeFile(victim, "untouched\n");
		await mkdir(join(projectDir, ".launchfile"));
		await symlink(victim, join(projectDir, ".launchfile", "state.json"));

		await expect(
			writeConfinedFile(projectDir, [".launchfile", "state.json"], "secrets", {
				mode: 0o600,
			}),
		).rejects.toThrow(
			`state.json is a symlink to ${victim}; refusing to write`,
		);
		expect(await readFile(victim, "utf8")).toBe("untouched\n");
	});

	it("refuses a file part with a separator before its symlinked segment is followed", async () => {
		await mkdir(join(projectDir, ".launchfile"), { mode: 0o700 });
		await symlink(victimDir, join(projectDir, ".launchfile", "env"));

		await expect(
			writeConfinedFile(
				projectDir,
				[".launchfile", "env/web.env"],
				"SECRET=1\n",
				{
					mode: 0o600,
				},
			),
		).rejects.toThrow(
			"env/web.env is not a single path component; refusing to write",
		);
		await expect(readdir(victimDir)).resolves.toEqual([]);
	});

	it("refuses when the parent directory is a symlink out of the project", async () => {
		await symlink(victimDir, join(projectDir, ".launchfile"));

		await expect(
			writeConfinedFile(projectDir, [".launchfile", ".gitignore"], "*\n", {
				mode: 0o644,
			}),
		).rejects.toBeInstanceOf(ConfinementRefusal);
		expect(await readdir(victimDir)).toEqual([]);
	});
});

describe("openConfinedFile", () => {
	it("appends rather than truncating when asked", async () => {
		const parts = [".launchfile", "logs", "web.log"];
		await writeConfinedFile(projectDir, parts, "first\n", { mode: 0o600 });

		const handle = await openConfinedFile(projectDir, parts, {
			mode: 0o600,
			append: true,
		});
		try {
			await handle.write("second\n");
		} finally {
			await handle.close();
		}

		expect(await readFile(join(projectDir, ...parts), "utf8")).toBe(
			"first\nsecond\n",
		);
	});
});
