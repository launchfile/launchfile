/**
 * Bun runtime installer via Homebrew.
 */

import { shellOk, shell } from "../shell.js";
import type { RuntimeInstaller } from "./types.js";

export class BunInstaller implements RuntimeInstaller {
	readonly runtime = "bun";

	async detectVersion(_projectDir: string): Promise<string | undefined> {
		// Bun doesn't have a standard version file yet; use whatever is installed
		return undefined;
	}

	async install(_version: string): Promise<void> {
		if (!(await shellOk("which bun"))) {
			await shell("brew install bun");
		}
	}

	async shellEnv(_version: string): Promise<Record<string, string>> {
		return {};
	}
}
