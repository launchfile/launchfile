/**
 * Node.js runtime installer via fnm (or nvm fallback).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { shell, shellOk } from "../shell.js";
import type { RuntimeInstaller } from "./types.js";

export class NodeInstaller implements RuntimeInstaller {
	readonly runtime = "node";

	async detectVersion(projectDir: string): Promise<string | undefined> {
		// Priority: .nvmrc > .node-version > package.json engines.node
		for (const file of [".nvmrc", ".node-version"]) {
			try {
				const content = await readFile(join(projectDir, file), "utf8");
				const version = content.trim();
				if (version) return version;
			} catch {
				// File doesn't exist
			}
		}

		try {
			const pkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
			if (pkg.engines?.node) return pkg.engines.node;
		} catch {
			// No package.json
		}

		return undefined;
	}

	async install(version: string): Promise<void> {
		// Prefer fnm (faster), fall back to nvm
		if (await shellOk("which fnm")) {
			await shell(`fnm install ${version}`);
		} else if (await shellOk("which nvm")) {
			await shell(`nvm install ${version}`);
		} else {
			console.log("  Installing fnm via brew...");
			await shell("brew install fnm");
			await shell(`fnm install ${version}`);
		}
	}

	async shellEnv(_version: string): Promise<Record<string, string>> {
		if (await shellOk("which fnm")) {
			try {
				const result = await shell("fnm env --shell bash", { silent: true });
				return parseShellEnv(result.stdout);
			} catch {
				return {};
			}
		}
		return {};
	}
}

/** Parse `export KEY="VALUE"` lines from fnm env output */
function parseShellEnv(output: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of output.split("\n")) {
		const match = /^export\s+(\w+)="?([^"]*)"?/.exec(line);
		if (match) {
			env[match[1]!] = match[2]!;
		}
	}
	return env;
}
