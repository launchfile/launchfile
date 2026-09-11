/**
 * The orchestrator-facing publication channel in this provider (D-58): a
 * supplied `appUrl` resolves `$app.*` instead of `http://localhost:<port>`,
 * it survives in state so `env` and `bootstrap` answer with it, and a
 * malformed value is refused before anything is provisioned or written.
 *
 * The mock set mirrors operator-storage.test.ts and for the same reason: real
 * subprocess exec and a real pm2 registration have no place in a unit test,
 * while `state.js`, `env-writer.js` and `port-allocator.js` run for real
 * against a temp project directory — so what is asserted is the value the
 * component's environment actually receives, not a stubbed derivation.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidAppUrlError, readLaunch } from "@launchfile/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeAppProperties } from "../env-writer.js";

const shellCalls: string[] = [];
const startRegistrations: { name: string; env: Record<string, string> }[] = [];
const writtenEnvFiles: { path: string; content: string }[] = [];
const consoleLogs: string[] = [];

vi.mock("node:fs/promises", () => ({
	readFile: async (path: string, encoding?: BufferEncoding) =>
		readFileSync(path, encoding ?? "utf8"),
	writeFile: async (
		path: string,
		content: string,
		opts?: { mode?: number },
	) => {
		writtenEnvFiles.push({ path: String(path), content: String(content) });
		writeFileSync(
			path,
			content,
			opts?.mode !== undefined ? { mode: opts.mode } : undefined,
		);
	},
	mkdir: async (
		path: string,
		opts?: { recursive?: boolean; mode?: number },
	) => {
		mkdirSync(path, opts);
	},
}));

vi.mock("../prereqs.js", () => ({
	checkPrereqs: async () => ({ ok: true, missing: [] }),
}));

vi.mock("../runtimes/index.js", () => ({
	getRuntimeInstaller: () => undefined,
}));

vi.mock("../shell.js", () => ({
	shell: async (cmd: string) => {
		shellCalls.push(cmd);
		return { exitCode: 0, stdout: "", stderr: "" };
	},
	shellOk: async () => true,
	shellScript: async (command: string) => {
		shellCalls.push(command);
		return { exitCode: 0, stdout: "", stderr: "" };
	},
}));

vi.mock("../process-manager.js", () => ({
	ProcessManager: class {
		register(name: string, opts: { env: Record<string, string> }) {
			startRegistrations.push({ name, env: opts.env });
		}
		async startAll() {}
		async stopAll() {}
		getRecordedProcesses() {
			return {};
		}
	},
}));

const { launchEnv, launchUp } = await import("../provider.js");
const { launchBootstrap } = await import("../bootstrap.js");

const LAUNCHFILE = `version: launch/v1
name: urltest
runtime: node
provides:
  - port: 3000
    protocol: http
    exposed: true
env:
  PUBLIC_URL:
    default: $app.url
  DOMAIN:
    default: $app.authority
  USE_TLS:
    default: $app.tls
commands:
  start: "node server.js"
  bootstrap: "echo $app.url"
`;

describe("computeAppProperties with appUrl (D-58 rules 2 and 4)", () => {
	const launch = readLaunch(LAUNCHFILE);

	it("resolves the full property set from the supplied URL", () => {
		expect(
			computeAppProperties(
				launch,
				{ default: 3000 },
				"https://notes.example.com",
			),
		).toEqual({
			name: "urltest",
			host: "notes.example.com",
			port: 443,
			url: "https://notes.example.com",
			authority: "notes.example.com",
			scheme: "https",
			tls: "true",
		});
	});

	it("ignores the allocated local port — it is not the public address", () => {
		const props = computeAppProperties(
			launch,
			{ default: 49500 },
			"https://notes.example.com",
		);
		expect(String(props.url)).not.toContain("49500");
		expect(props.port).toBe(443);
	});

	it("unset appUrl keeps this provider's own localhost routing answer", () => {
		expect(computeAppProperties(launch, { default: 3000 })).toEqual({
			name: "urltest",
			host: "localhost",
			port: 3000,
			url: "http://localhost:3000",
			authority: "localhost:3000",
			scheme: "http",
			tls: "false",
		});
	});

	it("refuses a malformed value instead of degrading (rule 3)", () => {
		expect(() =>
			computeAppProperties(launch, { default: 3000 }, "notes.example.com"),
		).toThrow(InvalidAppUrlError);
	});
});

describe("launchUp publication context (D-58)", () => {
	let projectDir: string;

	beforeEach(() => {
		shellCalls.length = 0;
		startRegistrations.length = 0;
		writtenEnvFiles.length = 0;
		consoleLogs.length = 0;
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-appurl-"));
		writeFileSync(join(projectDir, "Launchfile"), LAUNCHFILE);
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			consoleLogs.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(projectDir, { recursive: true, force: true });
	});

	function envLocal(): string {
		const file = writtenEnvFiles
			.filter((f) => f.path.endsWith(".env.local"))
			.at(-1);
		return file?.content ?? "";
	}

	function recordedAppUrl(): string | undefined {
		const raw = readFileSync(
			join(projectDir, ".launchfile", "state.json"),
			"utf8",
		);
		return (JSON.parse(raw) as { appUrl?: string }).appUrl;
	}

	it("resolves $app.* from a supplied appUrl, in the env the component receives", async () => {
		await launchUp({ projectDir, appUrl: "https://notes.example.com" });

		expect(envLocal()).toContain("PUBLIC_URL=https://notes.example.com");
		expect(envLocal()).toContain("DOMAIN=notes.example.com");
		expect(envLocal()).toContain("USE_TLS=true");
		expect(envLocal()).not.toContain("PUBLIC_URL=http://localhost");
		expect(startRegistrations[0]?.env.PUBLIC_URL).toBe(
			"https://notes.example.com",
		);
	});

	it("normalizes the supplied value before it reaches $app.* or state", async () => {
		await launchUp({ projectDir, appUrl: "HTTPS://Notes.Example.COM:443/" });

		expect(recordedAppUrl()).toBe("https://notes.example.com");
		expect(envLocal()).toContain("PUBLIC_URL=https://notes.example.com");
	});

	it("preserves the recorded appUrl when a later run omits the option", async () => {
		await launchUp({ projectDir, appUrl: "https://notes.example.com" });
		await launchUp({ projectDir });

		expect(recordedAppUrl()).toBe("https://notes.example.com");
		expect(envLocal()).toContain("PUBLIC_URL=https://notes.example.com");
		expect(envLocal()).not.toContain("PUBLIC_URL=http://localhost");
	});

	it("replaces the recorded appUrl when a different one is supplied (D-49)", async () => {
		await launchUp({ projectDir, appUrl: "https://old.example.com" });
		await launchUp({ projectDir, appUrl: "https://new.example.com" });

		expect(recordedAppUrl()).toBe("https://new.example.com");
		expect(envLocal()).toContain("PUBLIC_URL=https://new.example.com");
		expect(envLocal()).not.toContain("old.example.com");
	});

	it("keeps the localhost routing answer when nothing is recorded or supplied", async () => {
		await launchUp({ projectDir });

		expect(recordedAppUrl()).toBeUndefined();
		expect(envLocal()).toMatch(/PUBLIC_URL=http:\/\/localhost:\d+/);
	});

	it("refuses a malformed appUrl before anything is provisioned or written", async () => {
		await expect(
			launchUp({ projectDir, appUrl: "notes.example.com" }),
		).rejects.toThrow(InvalidAppUrlError);

		expect(shellCalls).toEqual([]);
		expect(startRegistrations).toEqual([]);
		expect(writtenEnvFiles).toEqual([]);
		expect(existsSync(join(projectDir, ".launchfile"))).toBe(false);
	});

	it("never echoes a credential embedded in a refused value (D-18)", async () => {
		const err = await launchUp({
			projectDir,
			appUrl: "https://admin:hunter2@notes.example.com/?x=1",
		}).catch((e: Error) => e);

		expect(err).toBeInstanceOf(InvalidAppUrlError);
		expect((err as Error).message).not.toContain("hunter2");
		expect((err as Error).message).toContain("***@");
	});

	it("`env` and `bootstrap` answer with the same $app.* the run was configured with", async () => {
		await launchUp({ projectDir, appUrl: "https://notes.example.com" });

		await launchEnv({ projectDir });
		expect(consoleLogs.join("\n")).toContain(
			"PUBLIC_URL=https://notes.example.com",
		);

		const commands: string[] = [];
		await launchBootstrap({
			projectDir,
			exec: async (_cmd: string, args: string[]) => {
				commands.push(args.at(-1) ?? "");
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		expect(commands).toEqual(["echo https://notes.example.com"]);
	});
});

const ORIGIN_REQUIRED = `version: launch/v1
name: origintest
components:
  web:
    runtime: node
    provides:
      - name: ui
        protocol: http
        port: 3000
        exposed: true
    requires:
      - type: https-origin
        endpoint: ui
        set_env:
          DOMAIN: $url
    env:
      PUBLIC_URL:
        default: $app.url
    commands:
      start: "node web.js"
  worker:
    runtime: node
    commands:
      start: "node worker.js"
`;

const ORIGIN_OPTIONAL = `version: launch/v1
name: origintest
runtime: node
provides:
  - name: ui
    protocol: http
    port: 3000
    exposed: true
supports:
  - type: https-origin
    endpoint: ui
    set_env:
      DOMAIN: $url
commands:
  start: "node web.js"
`;

/**
 * `https-origin` rides the publication-context channel (D-60 rule 5,
 * PROVIDERS.md §7): an https `appUrl` satisfies a required entry and wires its
 * `url`; anything else refuses the component with docker's reason. Asserted on
 * the env the process manager receives, so the outcome is what is pinned.
 */
describe("launchUp https-origin through the publication context (D-60 rule 5)", () => {
	let projectDir: string;
	const consoleErrors: string[] = [];
	const consoleWarns: string[] = [];

	beforeEach(() => {
		shellCalls.length = 0;
		startRegistrations.length = 0;
		writtenEnvFiles.length = 0;
		consoleLogs.length = 0;
		consoleErrors.length = 0;
		consoleWarns.length = 0;
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-origin-"));
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			consoleLogs.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			consoleWarns.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			consoleErrors.push(args.map(String).join(" "));
		});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(projectDir, { recursive: true, force: true });
	});

	const registered = (name: string) =>
		startRegistrations.find((r) => r.name === name)?.env;

	it("satisfies a required entry from an https appUrl and wires its url to $app.url", async () => {
		writeFileSync(join(projectDir, "Launchfile"), ORIGIN_REQUIRED);
		await launchUp({ projectDir, appUrl: "https://vw.example.com" });

		expect(registered("web")?.DOMAIN).toBe("https://vw.example.com");
		expect(registered("web")?.PUBLIC_URL).toBe("https://vw.example.com");
		expect(registered("worker")).toBeDefined();
		expect(consoleErrors.join("\n")).not.toContain("Refused");
		expect(consoleWarns.join("\n")).not.toContain("No provisioner for resource type: https-origin");
	});

	it("refuses the component when the supplied URL is http, naming the scheme", async () => {
		writeFileSync(join(projectDir, "Launchfile"), ORIGIN_REQUIRED);
		await launchUp({ projectDir, appUrl: "http://vw.example.com" });

		expect(registered("web")).toBeUndefined();
		expect(registered("worker")).toBeDefined();
		expect(consoleErrors.join("\n")).toContain(
			'Refused: web requires a public HTTPS origin this provider cannot supply (https-origin (endpoint "ui"): the supplied publication URL\'s scheme is "http", not https)',
		);
		expect(writtenEnvFiles.some((f) => f.path.endsWith("web.env"))).toBe(false);
	});

	it("refuses the component when nothing is supplied or recorded, saying so", async () => {
		writeFileSync(join(projectDir, "Launchfile"), ORIGIN_REQUIRED);
		await launchUp({ projectDir });

		expect(registered("web")).toBeUndefined();
		expect(consoleErrors.join("\n")).toContain(
			"no publication URL was supplied, and this provider has no edge of its own",
		);
		expect(consoleErrors.join("\n")).not.toContain("no publication channel");
	});

	it("a recorded https appUrl satisfies the entry on a later run that omits the option", async () => {
		writeFileSync(join(projectDir, "Launchfile"), ORIGIN_REQUIRED);
		await launchUp({ projectDir, appUrl: "https://vw.example.com" });
		startRegistrations.length = 0;
		await launchUp({ projectDir });

		expect(registered("web")?.DOMAIN).toBe("https://vw.example.com");
		expect(consoleErrors.join("\n")).not.toContain("Refused");
	});

	it("`env` resolves the entry's url from the recorded publication context", async () => {
		writeFileSync(join(projectDir, "Launchfile"), ORIGIN_REQUIRED);
		await launchUp({ projectDir, appUrl: "https://vw.example.com" });
		await launchEnv({ projectDir, component: "web" });

		expect(consoleLogs.join("\n")).toContain("DOMAIN=https://vw.example.com");
	});

	it("wires a satisfied `supports:` entry and leaves an unsatisfied one absent with a note", async () => {
		writeFileSync(join(projectDir, "Launchfile"), ORIGIN_OPTIONAL);
		await launchUp({ projectDir, appUrl: "https://vw.example.com" });
		expect(registered("default")?.DOMAIN).toBe("https://vw.example.com");
		expect(consoleWarns.join("\n")).not.toContain("optional public HTTPS origin");

		rmSync(join(projectDir, ".launchfile"), { recursive: true, force: true });
		startRegistrations.length = 0;
		await launchUp({ projectDir, appUrl: "http://vw.example.com" });
		expect(registered("default")).toBeDefined();
		expect(registered("default")?.DOMAIN).toBeUndefined();
		expect(consoleWarns.join("\n")).toContain(
			'optional public HTTPS origin not satisfied (https-origin (endpoint "ui"): the supplied publication URL\'s scheme is "http", not https) — running degraded',
		);
	});
});
