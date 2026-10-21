import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `test-app.ts` is a script, so its flag handling is exercised by spawning it
 * in `--dry-run` mode: that path parses the flags, prints the header, writes
 * the compose file and exits before anything is pulled or started.
 */
const script = resolve(import.meta.dirname, "test-app.ts");

function runHarness(...args: string[]) {
	const result = spawnSync("bun", ["run", script, ...args], {
		cwd: resolve(import.meta.dirname, ".."),
		encoding: "utf-8",
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("test-app --wait-timeout", () => {
	it("defaults to 120s and prints the budget in the header", () => {
		const { status, stdout } = runHarness("it-tools", "--dry-run");
		expect(status).toBe(0);
		expect(stdout).toContain("Wait budget: 120s");
	});

	it("accepts a positive whole number in either spelling", () => {
		expect(runHarness("it-tools", "--dry-run", "--wait-timeout", "360").stdout).toContain(
			"Wait budget: 360s",
		);
		expect(runHarness("it-tools", "--dry-run", "--wait-timeout=300").stdout).toContain(
			"Wait budget: 300s",
		);
	});

	it.each(["abc", "0", "-5", "1.5", ""])(
		"refuses %j before locating the Launchfile",
		(value) => {
			const { status, stderr, stdout } = runHarness("it-tools", "--dry-run", "--wait-timeout", value);
			expect(status).toBe(1);
			expect(stderr).toContain("--wait-timeout needs a positive whole number of seconds");
			expect(stdout).not.toContain("=== Testing:");
		},
	);
});
