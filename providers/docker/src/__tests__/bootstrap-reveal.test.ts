/**
 * Sensitive bootstrap captures on `@launchfile/docker` (#464, D-next):
 * masked on stdout unless the operator passes `--reveal`, and registered with
 * the redactor before any log line or failure record either way.
 *
 * `LAUNCHFILE_LOG_DIR` is set before the provider is imported so the real
 * logger writes its NDJSON file here — the assertion that a capture value
 * never reaches that file is made against the file, not against stderr.
 */

import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVEAL_HINT, readLaunch } from "@launchfile/sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

// `/var/...` (macOS's tmpdir) is on the logger's sensitive-path list; its
// realpath `/private/var/...` is not.
const logDir = await realpath(
	await mkdtemp(join(tmpdir(), "lf-bootstrap-reveal-")),
);
process.env.LAUNCHFILE_LOG_DIR = logDir;
const LOG_FILE = join(logDir, "launchfile-docker.log");

const bootstrap = await import("../bootstrap.js");
const errors = await import("../errors.js");
const redact = await import("../redact.js");

const INVITE =
	"https://acme.test/invite/PzEdyKQKfZIKDZ8HNtlm8g6K1ptolVAqjgIb4MWiRVg";

const LAUNCHFILE = `
version: launch/v1
name: acme
image: acme:1
commands:
  start: serve
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

const plan = () =>
	bootstrap.planBootstraps(readLaunch(LAUNCHFILE), {
		hostPorts: {},
		secrets: {},
	});

/** A fake `docker compose exec` whose child prints the link on stdout (and, when failing, echoes it on stderr too). */
function fakeExec(exitCode: number): bootstrap.BootstrapExec {
	return async () => ({
		exitCode,
		stdout: `Created invite\nuser: admin\n${INVITE}\n`,
		stderr: exitCode === 0 ? "" : `warning: invite ${INVITE} expires in 30m\n`,
	});
}

let out: string[];
let err: string[];
let restore: () => void;

beforeEach(() => {
	redact.clearRegisteredSecrets();
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

afterEach(() => restore());

afterAll(async () => {
	await rm(logDir, { recursive: true, force: true });
});

async function ndjson(): Promise<string> {
	return readFile(LOG_FILE, "utf8").catch(() => "");
}

describe("masked by default (SPEC.md § Command Capture, D-next)", () => {
	it("prints *** for the sensitive capture, the non-sensitive one in clear, then one hint line", async () => {
		await bootstrap.runBootstraps(plan(), {
			project: "lf-acme",
			exec: fakeExec(0),
		});
		const text = out.join("\n");
		expect(text).toContain("    invite_link: *** — One-time invite link");
		expect(text).toContain("    admin_user: admin — Admin login");
		expect(text).not.toContain(INVITE);
		expect(out.filter((l) => l.includes(REVEAL_HINT))).toHaveLength(1);
	});

	it("prints no hint when nothing was masked", async () => {
		const launch = readLaunch(
			"version: launch/v1\nname: acme\nimage: acme:1\ncommands:\n  start: serve\n  bootstrap:\n    command: x\n    capture:\n      admin_user:\n        pattern: 'user: (\\S+)'\n",
		);
		const item = bootstrap.planBootstraps(launch, {
			hostPorts: {},
			secrets: {},
		});
		await bootstrap.runBootstraps(item, {
			project: "lf-acme",
			exec: fakeExec(0),
		});
		expect(out.join("\n")).toContain("admin_user: admin");
		expect(out.join("\n")).not.toContain(REVEAL_HINT);
	});
});

describe("`--reveal` prints the value (the explicit act SPEC.md § Command Capture names)", () => {
	it("prints the sensitive capture in clear and no hint", async () => {
		await bootstrap.runBootstraps(plan(), {
			project: "lf-acme",
			exec: fakeExec(0),
			reveal: true,
		});
		const text = out.join("\n");
		expect(text).toContain(`    invite_link: ${INVITE} — One-time invite link`);
		expect(text).not.toContain("***");
		expect(text).not.toContain(REVEAL_HINT);
	});

	it("prints a non-sensitive capture identically in both modes", async () => {
		await bootstrap.runBootstraps(plan(), {
			project: "lf-acme",
			exec: fakeExec(0),
		});
		const masked = out.find((l) => l.includes("admin_user"));
		out = [];
		await bootstrap.runBootstraps(plan(), {
			project: "lf-acme",
			exec: fakeExec(0),
			reveal: true,
		});
		expect(out.find((l) => l.includes("admin_user"))).toBe(masked);
	});

	it("returns the raw value in the result in both modes — masking is display only", async () => {
		const [masked] = await bootstrap.runBootstraps(plan(), {
			project: "lf-acme",
			exec: fakeExec(0),
		});
		const [revealed] = await bootstrap.runBootstraps(plan(), {
			project: "lf-acme",
			exec: fakeExec(0),
			reveal: true,
		});
		expect(masked!.captures.invite_link).toBe(INVITE);
		expect(revealed!.captures.invite_link).toBe(INVITE);
	});
});

describe.each([
	["masked", false],
	["revealed", true],
])(
	"the value registers with the redactor before anything is logged or recorded (%s)",
	(_, reveal) => {
		it("scrubs the value from the redactor's output once the capture is extracted", async () => {
			expect(redact.redactSecrets(INVITE)).toBe(INVITE);
			await bootstrap.runBootstraps(plan(), {
				project: "lf-acme",
				exec: fakeExec(0),
				reveal,
			});
			expect(redact.redactSecrets(`link ${INVITE} here`)).toBe(
				`link ${redact.REDACTED} here`,
			);
		});

		it("keeps the value out of the NDJSON log on success and on failure", async () => {
			await bootstrap.runBootstraps(plan(), {
				project: "lf-acme",
				exec: fakeExec(0),
				reveal,
			});
			await bootstrap.runBootstraps(plan(), {
				project: "lf-acme",
				exec: fakeExec(1),
				reveal,
			});
			const log = await ndjson();
			const lines = log
				.split("\n")
				.filter((l) => l.includes("bootstrap command finished"));
			expect(lines.length).toBeGreaterThanOrEqual(2);
			expect(log).not.toContain(INVITE);
			// The failing run's stderr echoed the link; it landed scrubbed.
			const failed = lines
				.map((l) => JSON.parse(l) as Record<string, unknown>)
				.find((l) => l.exitCode === 1)!;
			expect(failed.stderr).toContain(redact.REDACTED);
			expect(failed.captured).toEqual(["invite_link", "admin_user"]);
		});

		it("prints a failing command's stderr scrubbed", async () => {
			await bootstrap.runBootstraps(plan(), {
				project: "lf-acme",
				exec: fakeExec(1),
				reveal,
			});
			const text = err.join("\n");
			expect(text).toContain("failed with exit code 1");
			expect(text).toContain(redact.REDACTED);
			expect(text).not.toContain(INVITE);
		});

		it("builds a failure record with the value scrubbed from stdout and stderr (what `diagnose` shows)", async () => {
			const [failed] = await bootstrap.runBootstraps(plan(), {
				project: "lf-acme",
				exec: fakeExec(1),
				reveal,
			});
			const record = errors.dockerLaunchError({
				phase: "bootstrap",
				key: "acme",
				slug: "acme",
				app: "acme",
				component: failed!.component,
				message: `bootstrap [${failed!.component}] failed with exit code ${failed!.exitCode}`,
				command: failed!.command,
				exitCode: failed!.exitCode,
				stdout: failed!.stdout,
				stderr: failed!.stderr,
			}).context;
			const serialized = JSON.stringify(record);
			expect(serialized).not.toContain(INVITE);
			expect(serialized).toContain(redact.REDACTED);
		});
	},
);

// Both declare exactly one sensitive capture: the only way to create the
// first user (D-34's motivating case).
describe("the catalog apps this exists for", () => {
	it.each(["paperclip", "remote-claude-concentrator"])(
		"%s: masked with a hint by default, printed under reveal",
		async (app) => {
			const launch = readLaunch(
				await readFile(
					new URL(
						`../../../../catalog/apps/${app}/Launchfile`,
						import.meta.url,
					),
					"utf8",
				),
			);
			const item = bootstrap.planBootstraps(launch, {
				hostPorts: { default: 3100 },
				secrets: {},
			});
			await bootstrap.runBootstraps(item, {
				project: `lf-${app}`,
				exec: fakeExec(0),
			});
			expect(out.join("\n")).toContain("invite_link: ***");
			expect(out.join("\n")).toContain(REVEAL_HINT);
			out = [];
			await bootstrap.runBootstraps(item, {
				project: `lf-${app}`,
				exec: fakeExec(0),
				reveal: true,
			});
			expect(out.join("\n")).toContain(`invite_link: ${INVITE}`);
		},
	);
});
