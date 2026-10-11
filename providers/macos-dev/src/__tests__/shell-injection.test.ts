import { exec, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeInstaller } from "../runtimes/node.js";
import { PythonInstaller } from "../runtimes/python.js";
import { RubyInstaller } from "../runtimes/ruby.js";
import { shell, shellScript } from "../shell.js";

// Spies that call straight through to the real functions, so every test in
// this file still spawns real processes while the argv each spawn received
// stays inspectable.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		exec: vi.fn(actual.exec),
		execFile: vi.fn(actual.execFile),
	};
});

/**
 * A runtime version is read verbatim out of the target repo (`.nvmrc`,
 * `.node-version`, `package.json` engines.node, `.ruby-version`,
 * `.python-version`) and handed to the installer. An installer that spliced it
 * into a command string would give any repository arbitrary command execution
 * during `launchfile up` (CWE-78).
 *
 * The defence is argv, not filtering: `detectVersion` still returns whatever
 * the file says, and these tests assert it stays inert anyway. They run the
 * real `install()` against stand-in version managers on PATH, so what is
 * asserted is the argv the OS received — not the shape of a mock.
 */

/** Every argument of every invocation, in order. Tab-separated on disk. */
type Invocations = string[][];

let binDir: string;
let originalPath: string | undefined;

/**
 * Put a stand-in for `name` on PATH. It records its own argv and prints
 * `stdout`, so a test can drive the installer's branches without a real fnm,
 * rbenv or pyenv — and without network access.
 */
async function fakeTool(
	name: string,
	stdout = "",
): Promise<() => Promise<Invocations>> {
	const log = join(binDir, `${name}.log`);
	const script = [
		"#!/bin/sh",
		`printf '%s\\t' "$@" >> '${log}'`,
		`printf '\\n' >> '${log}'`,
		`printf '%s' '${stdout}'`,
		"exit 0",
		"",
	].join("\n");
	await writeFile(join(binDir, name), script);
	await chmod(join(binDir, name), 0o755);

	return async () => {
		let contents: string;
		try {
			contents = await readFile(log, "utf8");
		} catch {
			return [];
		}
		return contents
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => line.split("\t").slice(0, -1));
	};
}

async function repoWith(file: string, contents: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "lf-injection-"));
	await writeFile(join(dir, file), contents);
	return dir;
}

beforeEach(async () => {
	binDir = await mkdtemp(join(tmpdir(), "lf-fakebin-"));
	originalPath = process.env.PATH;
	// Only the stand-ins and the system utilities they need. A real fnm, rbenv
	// or pyenv on the developer's PATH would otherwise decide which branch of
	// `install()` runs.
	process.env.PATH = `${binDir}:/usr/bin:/bin`;
	// `install()` echoes each command it runs; the assertions below are the
	// record that matters.
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	process.env.PATH = originalPath;
	vi.restoreAllMocks();
});

describe("shell() argument handling", () => {
	it("does not interpret shell metacharacters in an argument", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lf-injection-"));
		const marker = join(dir, "pwned");

		const result = await shell("echo", [`x; touch ${marker}`], {
			silent: true,
			allowFailure: true,
		});

		expect(existsSync(marker)).toBe(false);
		// The payload survives as one argument — proof it was handed over
		// rather than parsed.
		expect(result.stdout.trim()).toBe(`x; touch ${marker}`);
	});
});

describe("shellScript() command-string handling", () => {
	it("hands the command string to /bin/sh as a single -c argument", async () => {
		const command = "echo one | tr a-z A-Z && echo two";

		const result = await shellScript(command, { silent: true });

		expect(vi.mocked(execFile)).toHaveBeenCalledWith(
			"/bin/sh",
			["-c", command],
			expect.any(Object),
			expect.any(Function),
		);
		expect(vi.mocked(exec)).not.toHaveBeenCalled();
		// Pipes and `&&` still work: the author's string is shell syntax by
		// contract (SPEC.md § Command interpretation, D-48).
		expect(result).toEqual({ exitCode: 0, stdout: "ONE\ntwo\n", stderr: "" });
	});

	it("passes cwd, env and timeout through to the spawn", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lf-script-cwd-"));

		const result = await shellScript('printf "%s|%s" "$PWD" "$LF_PROBE"', {
			silent: true,
			cwd: dir,
			env: { LF_PROBE: "probe-value" },
			timeout: 5_000,
		});

		const [, , opts] = vi.mocked(execFile).mock.calls.at(-1) ?? [];
		expect(opts).toMatchObject({ cwd: dir, timeout: 5_000 });
		expect(result.stdout.endsWith(`|probe-value`)).toBe(true);
	});

	it("rejects on a non-zero exit, naming the command and stderr", async () => {
		await expect(
			shellScript("echo boom >&2; exit 3", { silent: true }),
		).rejects.toMatchObject({
			message: "Command failed: echo boom >&2; exit 3\nboom\n",
			result: { exitCode: 3, stdout: "", stderr: "boom\n" },
		});
	});

	it("resolves with the exit code when allowFailure is set", async () => {
		const result = await shellScript("exit 7", {
			silent: true,
			allowFailure: true,
		});

		expect(result.exitCode).toBe(7);
	});

	it("reports a timeout as a failure", async () => {
		const result = await shellScript("sleep 5", {
			silent: true,
			allowFailure: true,
			timeout: 100,
		});

		expect(result.exitCode).not.toBe(0);
	});

	it("echoes the command string, not the /bin/sh wrapper", async () => {
		const log = vi.mocked(console.log);

		await shellScript("true");

		expect(log).toHaveBeenCalledWith("  $ true");
	});
});

describe("a hostile version file cannot execute during install()", () => {
	const cases = [
		{
			runtime: "node",
			file: ".nvmrc",
			write: (marker: string) => `18; touch ${marker}\n`,
			version: (marker: string) => `18; touch ${marker}`,
			tool: "fnm",
			expected: (v: string) => [["install", v]],
		},
		{
			runtime: "node",
			file: "package.json",
			write: (marker: string) =>
				JSON.stringify({ engines: { node: `18; touch ${marker}` } }),
			version: (marker: string) => `18; touch ${marker}`,
			tool: "fnm",
			expected: (v: string) => [["install", v]],
		},
		{
			runtime: "ruby",
			file: ".ruby-version",
			write: (marker: string) => `3.3.0; touch ${marker}\n`,
			version: (marker: string) => `3.3.0; touch ${marker}`,
			tool: "rbenv",
			expected: (v: string) => [
				["versions", "--bare"],
				["install", v],
				["local", v],
			],
		},
		{
			runtime: "python",
			file: ".python-version",
			write: (marker: string) => `3.12.0; touch ${marker}\n`,
			version: (marker: string) => `3.12.0; touch ${marker}`,
			tool: "pyenv",
			expected: (v: string) => [
				["versions", "--bare"],
				["install", v],
				["local", v],
			],
		},
	] as const;

	const installers = {
		node: () => new NodeInstaller(),
		ruby: () => new RubyInstaller(),
		python: () => new PythonInstaller(),
	};

	for (const c of cases) {
		it(`${c.runtime}: a payload in ${c.file} reaches ${c.tool} as one argument`, async () => {
			const invocations = await fakeTool(c.tool);
			const marker = join(binDir, `pwned-${c.runtime}`);
			const repo = await repoWith(c.file, c.write(marker));

			const installer = installers[c.runtime]();
			const version = await installer.detectVersion(repo);
			expect(version).toBe(c.version(marker));

			await installer.install(version ?? "");

			expect(existsSync(marker)).toBe(false);
			// The whole payload arrived as a single argv element: the `;` was
			// never a command separator, so nothing after it ran.
			expect(await invocations()).toEqual(c.expected(c.version(marker)));
		});
	}

	it("node: falls back to nvm without ever building a command string", async () => {
		const invocations = await fakeTool("nvm");
		const marker = join(binDir, "pwned-nvm");
		const repo = await repoWith(".node-version", `20; touch ${marker}\n`);

		const version = await new NodeInstaller().detectVersion(repo);
		await new NodeInstaller().install(version ?? "");

		expect(existsSync(marker)).toBe(false);
		expect(await invocations()).toEqual([["install", `20; touch ${marker}`]]);
	});
});

describe("installed-version lookup matches exactly", () => {
	const cases = [
		{ runtime: "ruby", tool: "rbenv", make: () => new RubyInstaller() },
		{ runtime: "python", tool: "pyenv", make: () => new PythonInstaller() },
	] as const;

	for (const { runtime, tool, make } of cases) {
		// A `grep -q "^${version}$"` match reads the version as a regex, so
		// every `.` matches any character and an unrelated installed version
		// of the same length satisfies the request.
		it(`${runtime}: an installed 3x1 does not satisfy a request for 3.1`, async () => {
			const invocations = await fakeTool(tool, "3x1\n");

			await make().install("3.1");

			expect(await invocations()).toEqual([
				["versions", "--bare"],
				["install", "3.1"],
				["local", "3.1"],
			]);
		});

		it(`${runtime}: an exact match skips the install`, async () => {
			const invocations = await fakeTool(tool, "3.14\n3.9.1\n");

			await make().install("3.14");

			expect(await invocations()).toEqual([
				["versions", "--bare"],
				["local", "3.14"],
			]);
		});

		it(`${runtime}: a longer installed version does not satisfy a prefix`, async () => {
			const invocations = await fakeTool(tool, "3.14\n");

			await make().install("3.1");

			expect(await invocations()).toContainEqual(["install", "3.1"]);
		});
	}
});
