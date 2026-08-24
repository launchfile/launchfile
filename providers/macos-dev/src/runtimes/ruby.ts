/**
 * Ruby runtime installer via rbenv.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { shell, shellOk } from "../shell.js";
import { isInstalled } from "./installed-versions.js";
import type { RuntimeInstaller } from "./types.js";

export class RubyInstaller implements RuntimeInstaller {
	readonly runtime = "ruby";

	async detectVersion(projectDir: string): Promise<string | undefined> {
		try {
			const content = await readFile(join(projectDir, ".ruby-version"), "utf8");
			return content.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	async install(version: string): Promise<void> {
		// `version` is the verbatim contents of .ruby-version in the target repo —
		// untrusted input. It goes in as an argv element so it can never be read
		// as shell syntax.
		if (!(await shellOk("which", ["rbenv"]))) {
			await shell("brew", ["install", "rbenv", "ruby-build"]);
		}
		if (!(await isInstalled("rbenv", version))) {
			await shell("rbenv", ["install", version]);
		}
		await shell("rbenv", ["local", version]);
	}

	async shellEnv(_version: string): Promise<Record<string, string>> {
		if (await shellOk("which", ["rbenv"])) {
			try {
				const result = await shell("rbenv", ["init", "-", "bash"], {
					silent: true,
				});
				return parseRbenvEnv(result.stdout);
			} catch {
				return {};
			}
		}
		return {};
	}
}

function parseRbenvEnv(output: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of output.split("\n")) {
		const match = /^export\s+(\w+)="?([^"]*)"?/.exec(line);
		if (match) {
			env[match[1]!] = match[2]!;
		}
	}
	return env;
}
