/**
 * The error a failing `shell()` rejects with is serialized whole by the span
 * logger (`endSpan` logs `{ err }` on failure), so every string it carries must
 * already be redacted — attach-point redaction, not only capture-time (D-18,
 * CWE-532). These tests run a real subprocess; no docker involved.
 */

import { afterEach, describe, expect, it } from "vitest";
import { clearRegisteredSecrets, REDACTED, registerSecret } from "../redact.js";
import { shell, type ShellResult } from "../shell.js";

const SECRET = "shell-planted-secret-3f9c";

afterEach(() => clearRegisteredSecrets());

describe("shell — rejected errors carry only redacted output", () => {
	it("redacts a registered secret in the attached stderr and stdout", async () => {
		registerSecret(SECRET);
		const err = (await shell(
			"sh",
			["-c", `echo "out ${SECRET}"; echo "err ${SECRET}" >&2; exit 1`],
			{ silent: true },
		).catch((e: unknown) => e)) as Error & { result: ShellResult };

		expect(err).toBeInstanceOf(Error);
		expect(err.result.exitCode).toBe(1);
		expect(err.result.stdout).toContain(`out ${REDACTED}`);
		expect(err.result.stderr).toContain(`err ${REDACTED}`);
		expect(JSON.stringify(err.result)).not.toContain(SECRET);
	});

	it("returns raw output on the resolve path — callers parse it", async () => {
		registerSecret(SECRET);
		const result = await shell("sh", ["-c", `echo "out ${SECRET}"`], {
			silent: true,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(SECRET);
	});
});
