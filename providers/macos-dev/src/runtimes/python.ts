/**
 * Python runtime installer via pyenv.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { shell, shellOk } from "../shell.js";
import type { RuntimeInstaller } from "./types.js";

export class PythonInstaller implements RuntimeInstaller {
	readonly runtime = "python";

	async detectVersion(projectDir: string): Promise<string | undefined> {
		try {
			const content = await readFile(join(projectDir, ".python-version"), "utf8");
			return content.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	async install(version: string): Promise<void> {
		if (!(await shellOk("which pyenv"))) {
			await shell("brew install pyenv");
		}
		if (!(await shellOk(`pyenv versions --bare | grep -q "^${version}$"`))) {
			await shell(`pyenv install ${version}`);
		}
		await shell(`pyenv local ${version}`);
	}

	async shellEnv(_version: string): Promise<Record<string, string>> {
		if (await shellOk("which pyenv")) {
			const result = await shell("pyenv root", { silent: true, allowFailure: true });
			if (result.exitCode === 0) {
				const root = result.stdout.trim();
				return { PATH: `${root}/shims:${process.env.PATH ?? ""}` };
			}
		}
		return {};
	}
}
