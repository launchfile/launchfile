/**
 * Sensitive bootstrap captures on `@launchfile/macos-dev` (#464, D-62):
 * masked on stdout unless the operator passes `--reveal`, and registered with
 * the redactor before anything prints or persists either way.
 *
 * Runs the real `launchBootstrap` against a temp project directory with a
 * seeded state file and an injected exec — nothing spawns and nothing outside
 * the temp dir is touched.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVEAL_HINT } from "@launchfile/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BootstrapExec, launchBootstrap } from "../bootstrap.js";
import { clearRegisteredSecrets, REDACTED, redactSecrets } from "../redact.js";
import { initState, saveState } from "../state.js";

const INVITE =
	"https://acme.test/invite/PzEdyKQKfZIKDZ8HNtlm8g6K1ptolVAqjgIb4MWiRVg";

const LAUNCHFILE = `version: launch/v1
name: acme
runtime: node
commands:
  start: node server.js
  bootstrap:
    command: "acme-cli create-invite"
    capture:
      invite_link:
        pattern: "https?://\\\\S+"
        description: "One-time invite link"
        sensitive: true
      admin_user:
        pattern: "user: (\\\\S+)"
        description: "Admin login"
`;

function fakeExec(exitCode: number): BootstrapExec {
	return async () => ({
		exitCode,
		stdout: `Created invite\nuser: admin\n${INVITE}\n`,
		stderr: exitCode === 0 ? "" : `warning: invite ${INVITE} expires in 30m\n`,
	});
}

let projectDir: string;
let out: string[];
let err: string[];
let restore: () => void;

beforeEach(async () => {
	clearRegisteredSecrets();
	projectDir = await mkdtemp(join(tmpdir(), "lf-macos-reveal-"));
	await writeFile(join(projectDir, "Launchfile"), LAUNCHFILE);
	await saveState(projectDir, initState("acme", LAUNCHFILE));

	out = [];
	err = [];
	const log = console.log;
	const error = console.error;
	console.log = (...args: unknown[]) => out.push(args.join(" "));
	console.error = (...args: unknown[]) => err.push(args.join(" "));
	restore = () => {
		console.log = log;
		console.error = error;
	};
});

afterEach(async () => {
	restore();
	await rm(projectDir, { recursive: true, force: true });
});

const run = (opts: { reveal?: boolean; exitCode?: number } = {}) =>
	launchBootstrap({
		projectDir,
		exec: fakeExec(opts.exitCode ?? 0),
		reveal: opts.reveal,
	});

describe("masked by default (SPEC.md § Command Capture, D-62)", () => {
	it("prints *** for the sensitive capture, the non-sensitive one in clear, then one hint line", async () => {
		await run();
		const text = out.join("\n");
		expect(text).toContain("    invite_link: *** — One-time invite link");
		expect(text).toContain("    admin_user: admin — Admin login");
		expect(text).not.toContain(INVITE);
		expect(out.filter((l) => l.includes(REVEAL_HINT))).toHaveLength(1);
	});

	it("prints no hint when nothing was masked", async () => {
		await writeFile(
			join(projectDir, "Launchfile"),
			LAUNCHFILE.replace("        sensitive: true\n", ""),
		);
		await run();
		expect(out.join("\n")).toContain(`invite_link: ${INVITE}`);
		expect(out.join("\n")).not.toContain(REVEAL_HINT);
	});
});

describe("`--reveal` prints the value", () => {
	it("prints the sensitive capture in clear and no hint", async () => {
		await run({ reveal: true });
		const text = out.join("\n");
		expect(text).toContain(`    invite_link: ${INVITE} — One-time invite link`);
		expect(text).not.toContain("***");
		expect(text).not.toContain(REVEAL_HINT);
	});

	it("prints a non-sensitive capture identically in both modes", async () => {
		await run();
		const masked = out.find((l) => l.includes("admin_user"));
		out = [];
		await run({ reveal: true });
		expect(out.find((l) => l.includes("admin_user"))).toBe(masked);
	});
});

describe.each([
	["masked", false],
	["revealed", true],
])(
	"the value registers with the redactor before anything prints or persists (%s)",
	(_, reveal) => {
		it("scrubs the value from the redactor's output once the capture is extracted", async () => {
			expect(redactSecrets(INVITE)).toBe(INVITE);
			await run({ reveal });
			expect(redactSecrets(`link ${INVITE} here`)).toBe(
				`link ${REDACTED} here`,
			);
		});

		it("prints a failing command's stderr scrubbed, and reports rather than throws", async () => {
			const results = await run({ reveal, exitCode: 1 });
			expect(results[0]!.ok).toBe(false);
			const text = err.join("\n");
			expect(text).toContain("failed with exit code 1");
			expect(text).toContain(REDACTED);
			expect(text).not.toContain(INVITE);
		});

		it("leaves the value out of the state file", async () => {
			await run({ reveal, exitCode: 1 });
			const state = await readFile(
				join(projectDir, ".launchfile", "state.json"),
				"utf8",
			);
			expect(state).not.toContain(INVITE);
		});
	},
);
