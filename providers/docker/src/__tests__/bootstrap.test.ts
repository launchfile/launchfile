import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import {
	type BootstrapExec,
	computeAppProperties,
	DEFAULT_BOOTSTRAP_TIMEOUT_MS,
	extractCaptures,
	parseDuration,
	planBootstraps,
	runBootstraps,
} from "../bootstrap.js";
import { type CaptureEntry, readLaunch, resolveExpression } from "@launchfile/sdk";

describe("extractCaptures (D-34, docker provider)", () => {
	it("extracts invite link pattern from CLI output", () => {
		const captures: Record<string, CaptureEntry> = {
			invite_link: {
				pattern: "https?://\\S+",
				sensitive: true,
			},
		};
		const stdout = "Created invite\nhttps://example.com/invite/xyz\n";
		expect(extractCaptures(stdout, captures)).toEqual({
			invite_link: "https://example.com/invite/xyz",
		});
	});

	it("strips ANSI before matching (docker compose exec pty output)", () => {
		const captures: Record<string, CaptureEntry> = {
			token: { pattern: "token=(\\S+)" },
		};
		const stdout = "\x1b[1mGenerated:\x1b[0m token=s3cret\n";
		expect(extractCaptures(stdout, captures)).toEqual({
			token: "s3cret",
		});
	});

	it("returns empty object when no patterns match", () => {
		const captures: Record<string, CaptureEntry> = {
			nope: { pattern: "definitely-not-present" },
		};
		expect(extractCaptures("hello world", captures)).toEqual({});
	});

	it("silently skips invalid regex", () => {
		const captures: Record<string, CaptureEntry> = {
			bad: { pattern: "(unclosed" },
			ok: { pattern: "hello" },
		};
		const result = extractCaptures("hello", captures);
		expect(result.ok).toBe("hello");
		expect(result.bad).toBeUndefined();
	});

	it("supports multi-line captures across the command output", () => {
		const captures: Record<string, CaptureEntry> = {
			first: { pattern: "step1: (\\w+)" },
			second: { pattern: "step2: (\\w+)" },
		};
		const stdout = "step1: alpha\nstep2: beta\nstep3: done\n";
		expect(extractCaptures(stdout, captures)).toEqual({
			first: "alpha",
			second: "beta",
		});
	});
});

describe("parseDuration (docker provider)", () => {
	it("parses ms/s/m/h units", () => {
		expect(parseDuration("500ms")).toBe(500);
		expect(parseDuration("45s")).toBe(45_000);
		expect(parseDuration("3m")).toBe(180_000);
		expect(parseDuration("1h")).toBe(3_600_000);
	});

	it("throws on invalid input instead of substituting a default (PROVIDERS.md 10.10)", () => {
		expect(() => parseDuration("???")).toThrow(/invalid duration/);
		expect(() => parseDuration("")).toThrow(/invalid duration/);
	});

	it("rejects whitespace forms (ratified grammar, D-48)", () => {
		expect(() => parseDuration("5 m")).toThrow(/invalid duration/);
		expect(() => parseDuration(" 10s ")).toThrow(/invalid duration/);
	});
});

/**
 * The exact command `catalog/apps/paperclip/Launchfile` intends the container
 * shell to run. `$$NAME` in the file resolves to `$NAME` here, and nothing
 * else in the string changes.
 */
const PAPERCLIP_BOOTSTRAP = String.raw`CFG="$PAPERCLIP_HOME/instances/default/config.json"; test -f "$CFG" || { timeout 30 pnpm paperclipai onboard --yes >/dev/null 2>&1; sed -i "s/\"deploymentMode\": \"local_trusted\"/\"deploymentMode\": \"authenticated\"/" "$CFG"; }; pnpm paperclipai auth bootstrap-ceo --base-url "$BETTER_AUTH_URL"`;

const CATALOG_PAPERCLIP = new URL(
	"../../../../catalog/apps/paperclip/Launchfile",
	import.meta.url,
);

describe("planBootstraps — command interpretation (SPEC.md § Command interpretation)", () => {
	const plan = (command: string) =>
		planBootstraps(
			readLaunch(
				`version: launch/v1\nname: acme\nimage: acme:1\ncommands:\n  start: serve\n  bootstrap: ${JSON.stringify(command)}\n`,
			),
			{ hostPorts: {}, secrets: {} },
		)[0]!;

	it("keeps shell operators intact instead of splitting them into argv", () => {
		const item = plan("rails db:migrate && rails db:seed");
		expect(item.argv).toEqual(["sh", "-c", "rails db:migrate && rails db:seed"]);
	});

	it("passes the command as exactly one argv element", () => {
		const item = plan('sed -i "s/a/b/" f.json; echo done');
		expect(item.argv).toHaveLength(3);
		expect(item.argv[2]).toBe('sed -i "s/a/b/" f.json; echo done');
	});

	it("resolves $app.* before the shell sees the command", () => {
		const item = planBootstraps(
			readLaunch(
				"version: launch/v1\nname: acme\nimage: acme:1\nprovides:\n  - { protocol: http, port: 3000, exposed: true }\ncommands:\n  start: serve\n  bootstrap: 'seed --url $app.url'\n",
			),
			{ hostPorts: { default: 8080 }, secrets: {} },
		)[0]!;
		expect(item.argv).toEqual(["sh", "-c", "seed --url http://localhost:8080"]);
	});

	it.each(["   ", "\n\t ", "\t"])(
		"reports a command that resolves to whitespace only (%j)",
		(command) => {
			expect(plan(command).error).toBe("empty command");
		},
	);

	it("reports an unparseable timeout instead of substituting a default", () => {
		const item = planBootstraps(
			readLaunch(
				"version: launch/v1\nname: acme\nimage: acme:1\ncommands:\n  start: serve\n  bootstrap:\n    command: seed\n    timeout: '5 m'\n",
			),
			{ hostPorts: {}, secrets: {} },
		)[0]!;
		expect(item.error).toMatch(/invalid duration/);
	});

	it("honors a declared timeout and defaults when absent", () => {
		expect(plan("seed").timeoutMs).toBe(DEFAULT_BOOTSTRAP_TIMEOUT_MS);
		const item = planBootstraps(
			readLaunch(
				"version: launch/v1\nname: acme\nimage: acme:1\ncommands:\n  start: serve\n  bootstrap:\n    command: seed\n    timeout: 5m\n",
			),
			{ hostPorts: {}, secrets: {} },
		)[0]!;
		expect(item.timeoutMs).toBe(300_000);
	});
});

describe("paperclip bootstrap regression (issue #185)", () => {
	it("resolves the catalog Launchfile to the authored shell script, byte for byte", () => {
		const launch = readLaunch(readFileSync(CATALOG_PAPERCLIP, "utf8"));
		const item = planBootstraps(launch, {
			hostPorts: { default: 3100 },
			secrets: {},
		})[0]!;

		// Exact string, not argc: three blanked substitutions still produce 27
		// argv tokens, so an argc assertion passes on a broken command.
		expect(item.command).toBe(PAPERCLIP_BOOTSTRAP);
		expect(item.argv).toEqual(["sh", "-c", PAPERCLIP_BOOTSTRAP]);
		expect(item.error).toBeUndefined();
	});
});

describe("runBootstraps — docker exec argv shape", () => {
	it("hands docker compose exec the command as a single sh -c element", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const calls: { cmd: string; args: string[]; timeoutMs: number }[] = [];
		const exec: BootstrapExec = async (cmd, args, opts) => {
			calls.push({ cmd, args, timeoutMs: opts.timeoutMs });
			return { exitCode: 0, stdout: "https://acme.test/invite/abc", stderr: "" };
		};

		const launch = readLaunch(readFileSync(CATALOG_PAPERCLIP, "utf8"));
		const plan = planBootstraps(launch, { hostPorts: { default: 3100 }, secrets: {} });
		const results = await runBootstraps(plan, { project: "lf-paperclip", exec });

		expect(calls).toHaveLength(1);
		expect(calls[0]!.cmd).toBe("docker");
		expect(calls[0]!.args).toEqual([
			"compose",
			"-p",
			"lf-paperclip",
			"exec",
			"-T",
			"paperclip",
			"sh",
			"-c",
			PAPERCLIP_BOOTSTRAP,
		]);
		expect(results[0]!.ok).toBe(true);
		expect(results[0]!.captures.invite_link).toBe("https://acme.test/invite/abc");
		vi.restoreAllMocks();
	});

	it("reports a plan item that cannot run without invoking docker", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const exec: BootstrapExec = async () => {
			throw new Error("must not run");
		};
		const results = await runBootstraps(
			[
				{
					component: "default",
					service: "acme",
					command: "",
					argv: ["sh", "-c", ""],
					timeoutMs: DEFAULT_BOOTSTRAP_TIMEOUT_MS,
					error: "empty command",
				},
			],
			{ project: "lf-acme", exec },
		);
		expect(results[0]!.ok).toBe(false);
		expect(results[0]!.stderr).toBe("empty command");
		vi.restoreAllMocks();
	});
});

describe("computeAppProperties (D-33, D-35, docker provider)", () => {
	const launch = readLaunch(`
name: expr-in-command
components:
  default:
    image: nginx:alpine
    provides:
      - port: 8080
        protocol: http
    commands:
      bootstrap: "cli --url $app.url --authority $app.authority --tls $app.tls"
`);

	// The context bootstrap.ts and release.ts build for command-string resolution.
	const commandContext = (hostPorts: Record<string, number>) => ({
		secrets: {},
		app: computeAppProperties(launch, hostPorts),
	});

	it("supplies the full D-35 set, matching compose-generator's helper", () => {
		expect(computeAppProperties(launch, { default: 49200 })).toEqual({
			name: "expr-in-command",
			host: "localhost",
			port: 49200,
			url: "http://localhost:49200",
			authority: "localhost:49200",
			scheme: "http",
			tls: "false",
		});
	});

	it("resolves $app.authority / $app.scheme / $app.tls inside a bootstrap command string", () => {
		const command = launch.components.default!.commands!.bootstrap!.command;
		expect(resolveExpression(command, commandContext({ default: 49200 }))).toBe(
			"cli --url http://localhost:49200 --authority localhost:49200 --tls false",
		);
	});

	it("degrades the whole set to empty for an app with no exposed component", () => {
		const noPorts = readLaunch(`
name: headless
components:
  default:
    image: nginx:alpine
`);
		expect(computeAppProperties(noPorts, {})).toMatchObject({
			port: 0,
			url: "",
			authority: "",
			scheme: "",
			tls: "",
		});
	});
});
