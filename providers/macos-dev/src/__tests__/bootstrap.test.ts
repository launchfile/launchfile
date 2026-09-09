import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseDuration as parseHealthDuration } from "../health.js";
import {
	BOOTSTRAP_SHELL,
	DEFAULT_BOOTSTRAP_TIMEOUT_MS,
	extractCaptures,
	parseDuration,
	planBootstraps,
} from "../bootstrap.js";
import { buildResolverContext, computeAppProperties } from "../env-writer.js";
import { type CaptureEntry, readLaunch, type ResolverContext } from "@launchfile/sdk";

describe("extractCaptures (D-34)", () => {
	it("extracts a single-group regex from stdout", () => {
		const captures: Record<string, CaptureEntry> = {
			invite_link: {
				pattern: "https?://\\S+",
				description: "One-time invite link",
				sensitive: true,
			},
		};
		const stdout =
			"Admin created.\nInvite URL: https://example.com/invite/abc123\n";
		expect(extractCaptures(stdout, captures)).toEqual({
			invite_link: "https://example.com/invite/abc123",
		});
	});

	it("uses first capture group when present", () => {
		const captures: Record<string, CaptureEntry> = {
			password: {
				pattern: "Admin password: (.+)",
			},
		};
		const stdout = "Admin password: s3cret!\n";
		expect(extractCaptures(stdout, captures)).toEqual({
			password: "s3cret!",
		});
	});

	it("returns empty result when no patterns match", () => {
		const captures: Record<string, CaptureEntry> = {
			token: { pattern: "token=(\\S+)" },
		};
		expect(extractCaptures("nothing to see here", captures)).toEqual({});
	});

	it("strips ANSI escape codes before matching", () => {
		const captures: Record<string, CaptureEntry> = {
			url: { pattern: "https?://\\S+" },
		};
		// Simulates colorized output from a CLI tool that detects a TTY
		const stdout =
			"\x1b[32mSuccess:\x1b[0m visit \x1b[4mhttps://example.com/admin\x1b[0m to continue";
		expect(extractCaptures(stdout, captures)).toEqual({
			url: "https://example.com/admin",
		});
	});

	it("ends an OSC string at ST, keeping an OSC 8 hyperlink's link text", () => {
		const esc = String.fromCharCode(27);
		const captures: Record<string, CaptureEntry> = {
			invite_link: { pattern: "https?://\\S+" },
		};
		// An OSC 8 hyperlink whose visible text is the URL itself. Both OSC
		// strings end with ST (`ESC \\`), never BEL — the shape a pattern that
		// only stops at BEL runs straight past (ECMA-48 § 8.3.89).
		const url = "https://example.com/invite/abc123";
		const stdout = `${esc}]8;;${url}${esc}\\${url}${esc}]8;;${esc}\\\n`;
		expect(extractCaptures(stdout, captures)).toEqual({ invite_link: url });
	});

	it("strips a BEL-terminated OSC title", () => {
		const esc = String.fromCharCode(27);
		const bel = String.fromCharCode(7);
		const captures: Record<string, CaptureEntry> = {
			token: { pattern: "token=(\\S+)" },
		};
		const stdout = `${esc}]0;window title${bel}token=s3cret\n`;
		expect(extractCaptures(stdout, captures)).toEqual({ token: "s3cret" });
	});

	it("stays linear on a run of unterminated OSC starts (CWE-1333)", () => {
		const esc = String.fromCharCode(27);
		const captures: Record<string, CaptureEntry> = {
			token: { pattern: "token=(\\S+)" },
		};
		// Every `ESC ]` opens an OSC string no BEL ever closes. Unbounded, each
		// start rescanned the whole remainder — quadratic: 40 000 pairs took 1.8s.
		const stdout = `${`${esc}]`.repeat(40_000)}token=s3cret`;
		const t0 = performance.now();
		expect(extractCaptures(stdout, captures)).toEqual({ token: "s3cret" });
		expect(performance.now() - t0).toBeLessThan(250);
	});

	it("skips invalid regex without throwing", () => {
		const captures: Record<string, CaptureEntry> = {
			bad: { pattern: "(unclosed" },
			good: { pattern: "ok" },
		};
		const result = extractCaptures("ok here", captures);
		// good matches; bad is skipped
		expect(result.good).toBe("ok");
		expect(result.bad).toBeUndefined();
	});

	it("handles multiple captures in one stdout", () => {
		const captures: Record<string, CaptureEntry> = {
			user: { pattern: "user=(\\S+)" },
			pw: { pattern: "pw=(\\S+)" },
		};
		const stdout = "Created user=alice pw=hunter2 expires=1h\n";
		expect(extractCaptures(stdout, captures)).toEqual({
			user: "alice",
			pw: "hunter2",
		});
	});

	it("returns full match when pattern has no capture group", () => {
		const captures: Record<string, CaptureEntry> = {
			hash: { pattern: "[a-f0-9]{8}" },
		};
		const stdout = "Commit: deadbeef\n";
		expect(extractCaptures(stdout, captures)).toEqual({
			hash: "deadbeef",
		});
	});
});

describe("parseDuration", () => {
	it("parses ms, s, m, h units", () => {
		expect(parseDuration("500ms")).toBe(500);
		expect(parseDuration("30s")).toBe(30_000);
		expect(parseDuration("5m")).toBe(300_000);
		expect(parseDuration("2h")).toBe(7_200_000);
	});

	it("rejects whitespace forms (ratified grammar, D-48)", () => {
		expect(() => parseDuration(" 10s ")).toThrow(/invalid duration/);
		expect(() => parseDuration("5 m")).toThrow(/invalid duration/);
	});

	it("throws on invalid input instead of substituting a default (PROVIDERS.md 10.10)", () => {
		expect(() => parseDuration("bogus")).toThrow(/invalid duration/);
		expect(() => parseDuration("")).toThrow(/invalid duration/);
	});
});

describe("health durations use the ratified grammar (D-48)", () => {
	it("accepts the hour unit the local parser used to drop", () => {
		// The old health.ts regex was ^(\d+)(ms|s|m)$ with a silent `return 0`,
		// so a spec-valid `interval: "1h"` became a zero-length poll that could
		// never pass — a P-5 divergence from Docker on a value validate accepts.
		expect(parseHealthDuration("1h")).toBe(3_600_000);
		expect(parseHealthDuration("2h")).toBe(7_200_000);
	});

	it("still parses the units it always did", () => {
		expect(parseHealthDuration("500ms")).toBe(500);
		expect(parseHealthDuration("30s")).toBe(30_000);
		expect(parseHealthDuration("5m")).toBe(300_000);
	});

	it("throws rather than silently substituting a default", () => {
		// PROVIDERS.md §10.10: a provider MUST NOT substitute for an unparseable
		// duration. The old parser returned 0 here.
		expect(() => parseHealthDuration("5 minutes")).toThrow(/invalid duration/);
		expect(() => parseHealthDuration("1.5h")).toThrow(/invalid duration/);
		expect(() => parseHealthDuration("30 s")).toThrow(/invalid duration/);
	});
});

/**
 * The exact command `catalog/apps/paperclip/Launchfile` intends the shell to
 * run. `$$NAME` in the file resolves to `$NAME` here, and nothing else in the
 * string changes.
 */
const PAPERCLIP_BOOTSTRAP = String.raw`CFG="$PAPERCLIP_HOME/instances/default/config.json"; test -f "$CFG" || { timeout 30 pnpm paperclipai onboard --yes >/dev/null 2>&1; sed -i "s/\"deploymentMode\": \"local_trusted\"/\"deploymentMode\": \"authenticated\"/" "$CFG"; }; pnpm paperclipai auth bootstrap-ceo --base-url "$BETTER_AUTH_URL"`;

const CATALOG_PAPERCLIP = new URL(
	"../../../../catalog/apps/paperclip/Launchfile",
	import.meta.url,
);

function contextFor(
	launch: ReturnType<typeof readLaunch>,
	ports: Record<string, number>,
): ResolverContext {
	return buildResolverContext({}, ports, {}, computeAppProperties(launch, ports));
}

describe("planBootstraps — command interpretation (SPEC.md § Command interpretation)", () => {
	const plan = (command: string) => {
		const launch = readLaunch(
			`version: launch/v1\nname: acme\nimage: acme:1\ncommands:\n  start: serve\n  bootstrap: ${JSON.stringify(command)}\n`,
		);
		return planBootstraps(launch, contextFor(launch, {}))[0]!;
	};

	it("keeps shell operators intact instead of splitting them into argv", () => {
		const item = plan("rails db:migrate && rails db:seed");
		expect(item.argv).toEqual([
			BOOTSTRAP_SHELL,
			"-c",
			"rails db:migrate && rails db:seed",
		]);
	});

	it("passes the command as exactly one argv element", () => {
		const item = plan('sed -i "s/a/b/" f.json; echo done');
		expect(item.argv).toHaveLength(3);
		expect(item.argv[0]).toBe("/bin/sh");
		expect(item.argv[2]).toBe('sed -i "s/a/b/" f.json; echo done');
	});

	it("resolves $app.* before the shell sees the command", () => {
		const launch = readLaunch(
			"version: launch/v1\nname: acme\nimage: acme:1\nprovides:\n  - { protocol: http, port: 3000, exposed: true }\ncommands:\n  start: serve\n  bootstrap: 'seed --url $app.url'\n",
		);
		const item = planBootstraps(launch, contextFor(launch, { default: 8080 }))[0]!;
		expect(item.argv).toEqual([BOOTSTRAP_SHELL, "-c", "seed --url http://localhost:8080"]);
	});

	it.each(["   ", "\n\t ", "\t"])(
		"reports a command that resolves to whitespace only (%j)",
		(command) => {
			expect(plan(command).error).toBe("empty command");
		},
	);

	it("reports an unparseable timeout instead of substituting a default", () => {
		const launch = readLaunch(
			"version: launch/v1\nname: acme\nimage: acme:1\ncommands:\n  start: serve\n  bootstrap:\n    command: seed\n    timeout: '5 m'\n",
		);
		const item = planBootstraps(launch, contextFor(launch, {}))[0]!;
		expect(item.error).toMatch(/invalid duration/);
	});

	it("honors a declared timeout and defaults when absent", () => {
		expect(plan("seed").timeoutMs).toBe(DEFAULT_BOOTSTRAP_TIMEOUT_MS);
		const launch = readLaunch(
			"version: launch/v1\nname: acme\nimage: acme:1\ncommands:\n  start: serve\n  bootstrap:\n    command: seed\n    timeout: 5m\n",
		);
		expect(planBootstraps(launch, contextFor(launch, {}))[0]!.timeoutMs).toBe(300_000);
	});

	it("restricts the plan to a named component", () => {
		const launch = readLaunch(
			"version: launch/v1\nname: acme\ncomponents:\n  api:\n    image: acme/api:1\n    commands:\n      start: serve\n      bootstrap: api-seed\n  web:\n    image: acme/web:1\n    commands:\n      start: serve\n      bootstrap: web-seed\n",
		);
		const plan = planBootstraps(launch, contextFor(launch, {}), { component: "web" });
		expect(plan).toHaveLength(1);
		expect(plan[0]!.argv[2]).toBe("web-seed");
	});
});

describe("paperclip bootstrap regression (issue #185)", () => {
	it("resolves the catalog Launchfile to the authored shell script, byte for byte", () => {
		const launch = readLaunch(readFileSync(CATALOG_PAPERCLIP, "utf8"));
		const item = planBootstraps(launch, contextFor(launch, { default: 3100 }))[0]!;

		// Exact string, not argc: three blanked substitutions still produce 27
		// argv tokens, so an argc assertion passes on a broken command.
		expect(item.command).toBe(PAPERCLIP_BOOTSTRAP);
		expect(item.argv).toEqual([BOOTSTRAP_SHELL, "-c", PAPERCLIP_BOOTSTRAP]);
		expect(item.error).toBeUndefined();
	});
});
