import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeInstaller } from "../runtimes/node.js";
import { PythonInstaller } from "../runtimes/python.js";
import { RubyInstaller } from "../runtimes/ruby.js";
import { shell } from "../shell.js";

/**
 * A runtime version is read verbatim out of the target repo (`.nvmrc`,
 * `.node-version`, `package.json` engines.node, `.ruby-version`,
 * `.python-version`) and handed to the installer. While the installers built
 * command strings, that value was spliced into `/bin/sh -c` and a repository
 * could run arbitrary commands during `launchfile up` (CWE-78).
 *
 * The defence is argv, not filtering: `detectVersion` still returns whatever
 * the file says, and these tests assert it stays inert anyway.
 */
const PAYLOAD = "18; touch ";

async function repoWith(file: string, contents: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "lf-injection-"));
	await writeFile(join(dir, file), contents);
	return dir;
}

async function exists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

describe("shell() argument handling", () => {
	it("does not interpret shell metacharacters in an argument", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lf-injection-"));
		const marker = join(dir, "pwned");

		const result = await shell("echo", [`x; touch ${marker}`], {
			silent: true,
			allowFailure: true,
		});

		expect(await exists(marker)).toBe(false);
		// The payload survives as one argument — proof it was handed over
		// rather than parsed.
		expect(result.stdout.trim()).toBe(`x; touch ${marker}`);
	});
});

describe("runtime version strings are never shell-parsed", () => {
	const cases = [
		{ name: "node", file: ".nvmrc", make: () => new NodeInstaller() },
		{ name: "ruby", file: ".ruby-version", make: () => new RubyInstaller() },
		{
			name: "python",
			file: ".python-version",
			make: () => new PythonInstaller(),
		},
	] as const;

	for (const { name, file, make } of cases) {
		it(`${name}: a hostile ${file} reaches install() verbatim and stays inert`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "lf-marker-"));
			const marker = join(dir, "pwned");
			const repo = await repoWith(file, `${PAYLOAD}${marker}\n`);

			const version = await make().detectVersion(repo);
			expect(version).toBe(`${PAYLOAD}${marker}`);

			await shell("echo", ["install", version ?? ""], {
				silent: true,
				allowFailure: true,
			});
			expect(await exists(marker)).toBe(false);
		});
	}
});
