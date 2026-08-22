/**
 * The RFC #118 merge gate: `launchfile validate` MUST emit a
 * "host capabilities requested: […]" summary listing the app's requested
 * capabilities — the #113 privilege-surface floor. Exercises the built CLI
 * end-to-end against both spellings: the D-44 `host:` entry form and the
 * legacy top-level `host:` block.
 */

import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PKG_ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(PKG_ROOT, "dist", "cli.js");
const EXAMPLES = resolve(PKG_ROOT, "..", "..", "spec", "examples");

function run(cliArgs: string[]): { stdout: string; exitCode: number } {
	try {
		const stdout = execFileSync("node", [CLI, ...cliArgs], {
			encoding: "utf-8",
			env: { ...process.env, NO_COLOR: "1" },
		});
		return { stdout, exitCode: 0 };
	} catch (err) {
		const e = err as { stdout: string; status: number };
		return { stdout: e.stdout ?? "", exitCode: e.status ?? 1 };
	}
}

describe("launchfile validate — host capabilities summary (D-44 merge gate)", () => {
	it("lists capabilities requested via the new entry form", () => {
		const { stdout, exitCode } = run([
			"validate",
			join(EXAMPLES, "host-container-runtime.yaml"),
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("host capabilities requested:");
		expect(stdout).toContain("container_runtime=docker (required)");
	});

	it("lists capabilities requested via the legacy host block", () => {
		const { stdout, exitCode } = run([
			"validate",
			join(EXAMPLES, "host-orchestrator.yaml"),
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("host capabilities requested:");
		expect(stdout).toContain("container_runtime=docker (required)");
		expect(stdout).toContain("network=host (required)");
		expect(stdout).toContain("filesystem=read-write (required)");
	});

	it("includes hostCapabilities in --json output", () => {
		const { stdout, exitCode } = run([
			"validate",
			join(EXAMPLES, "host-container-runtime.yaml"),
			"--json",
		]);
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout);
		expect(result.valid).toBe(true);
		expect(result.hostCapabilities).toEqual(["container_runtime=docker (required)"]);
	});

	it("emits no summary when no capabilities are requested", () => {
		const { stdout, exitCode } = run(["validate", join(EXAMPLES, "minimal.yaml")]);
		expect(exitCode).toBe(0);
		expect(stdout).not.toContain("host capabilities requested:");
	});
});
