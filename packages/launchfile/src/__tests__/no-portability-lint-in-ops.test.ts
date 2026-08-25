/**
 * PROVIDERS.md §6 states in bold that the D-40/D-43 reduced-portability
 * diagnostics are "never emitted by operational commands (up/down/logs/…)" —
 * `lintLaunch` is the only place either diagnostic is produced (sdk/src/lint.ts),
 * and `cmdValidate` (sdk/src/commands.ts) is its only caller outside tests. This
 * pins that structurally: the operational command surface must not import
 * `lintLaunch`, directly or via a re-export, so a portability warning can never
 * reach `up`/`down`/`status`/`logs`/`bootstrap`/`list` output.
 *
 * `bun test` (this package's CI step) runs both this file's compiled `dist/`
 * copy and its `src/` original, so extensions are resolved dynamically —
 * commands live in `.ts` under `src/` and `.js` under `dist/`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const COMMANDS_DIR = resolve(import.meta.dirname, "..", "commands");
const COMMAND_NAMES = ["up", "down", "status", "logs", "bootstrap", "list"];

/** Resolve `<dir>/<base>` to whichever of `.ts`/`.js` actually exists (never `.d.ts`). */
function resolveSource(dir: string, base: string): string {
	for (const ext of [".ts", ".js"]) {
		const candidate = resolve(dir, `${base}${ext}`);
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`No .ts or .js source found for ${dir}/${base}`);
}

describe("operational commands never emit portability lint (PROVIDERS.md §6)", () => {
	it("every command file in commands/ is accounted for", () => {
		const present = readdirSync(COMMANDS_DIR)
			.filter((f) => !f.endsWith(".d.ts") && !f.endsWith(".map"))
			.map((f) => f.replace(/\.(ts|js)$/, ""));
		for (const name of COMMAND_NAMES) {
			expect(present).toContain(name);
		}
	});

	for (const name of COMMAND_NAMES) {
		it(`${name} does not import lintLaunch`, () => {
			const source = readFileSync(resolveSource(COMMANDS_DIR, name), "utf-8");
			expect(source).not.toMatch(/\blintLaunch\b/);
		});
	}

	it("cli.ts routes validate through cmdValidate, not lintLaunch directly", () => {
		const cliPath = resolveSource(resolve(import.meta.dirname, ".."), "cli");
		const cli = readFileSync(cliPath, "utf-8");
		expect(cli).not.toMatch(/\blintLaunch\b/);
		expect(cli).toContain("cmdValidate");
	});
});
