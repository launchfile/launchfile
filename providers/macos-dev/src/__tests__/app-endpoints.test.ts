/**
 * `$app.endpoints.<name>.*` under this provider (D-63 rule 4, #294): every
 * property of every named published endpoint resolves "" — the primary's
 * included — and `up` says so once, naming the endpoints the file references.
 * The allocator hands out one port per component, so there is no per-endpoint
 * address to publish; `$app.*` keeps its own routing answer.
 *
 * The mock set mirrors provider-required-env.test.ts and for the same reason:
 * no real subprocess and no real pm2 registration in a unit test, while
 * `state.js`, `env-writer.js` and `port-allocator.js` run for real against a
 * temp project directory.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	APP_ENDPOINT_PROPERTIES,
	readLaunch,
	UNPUBLISHED_APP_ENDPOINT,
} from "@launchfile/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildResolverContext,
	computeAppEndpoints,
	computeAppProperties,
} from "../env-writer.js";

const writtenEnvFiles: { path: string; content: string }[] = [];
const consoleWarns: string[] = [];

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
	chmod: async (path: string, mode: number) => {
		chmodSync(path, mode);
	},
}));

vi.mock("../prereqs.js", () => ({
	checkPrereqs: async () => ({ ok: true, missing: [] }),
}));

vi.mock("../runtimes/index.js", () => ({
	getRuntimeInstaller: () => undefined,
}));

vi.mock("../shell.js", () => ({
	shell: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	shellOk: async () => true,
	shellScript: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
}));

vi.mock("../process-manager.js", () => ({
	ProcessManager: class {
		register() {}
		async startAll() {}
		async stopAll() {}
		getRecordedProcesses() {
			return {};
		}
	},
}));

const { launchUp } = await import("../provider.js");

const GITEA_SHAPE = `
name: gitea
runtime: go
provides:
  - name: web
    protocol: http
    port: 3000
    exposed: true
  - name: ssh
    protocol: tcp
    port: 22
    exposed: true
env:
  ROOT_URL:
    default: $app.url
  WEB_URL:
    default: $app.endpoints.web.url
  SSH_DOMAIN:
    default: $app.endpoints.ssh.host
  SSH_PORT:
    default: $app.endpoints.ssh.port
commands:
  start: "gitea web"
`;

describe("computeAppEndpoints (D-63 rule 4)", () => {
	it("registers the empty answer for every named published endpoint, the primary included", () => {
		const endpoints = computeAppEndpoints(readLaunch(GITEA_SHAPE));
		expect(Object.keys(endpoints).sort()).toEqual(["ssh", "web"]);
		expect(endpoints.web).toBe(UNPUBLISHED_APP_ENDPOINT);
		for (const prop of APP_ENDPOINT_PROPERTIES) {
			expect(endpoints.ssh![prop]).toBe("");
		}
	});

	it("registers nothing for an unnamed or unpublished endpoint", () => {
		const endpoints = computeAppEndpoints(
			readLaunch(`
name: plain
runtime: node
provides:
  - protocol: http
    port: 3000
    exposed: true
  - name: metrics
    protocol: http
    port: 9090
commands:
  start: "node server.js"
`),
		);
		expect(endpoints).toEqual({});
	});

	it("rides the resolver context beside $app.*, never inside it", () => {
		const launch = readLaunch(GITEA_SHAPE);
		const ports = { default: 3000 };
		const ctx = buildResolverContext(
			{},
			ports,
			{},
			computeAppProperties(launch, ports),
			computeAppEndpoints(launch),
		);
		expect(ctx.app?.url).toBe("http://localhost:3000");
		expect(ctx.app?.endpoints).toBeUndefined();
		expect(ctx.appEndpoints?.ssh).toBe(UNPUBLISHED_APP_ENDPOINT);
	});
});

describe('launchUp — $app.endpoints.* resolves "" and says so (D-63 rule 4, #294)', () => {
	let projectDir: string;

	beforeEach(() => {
		writtenEnvFiles.length = 0;
		consoleWarns.length = 0;
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-app-endpoints-"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			consoleWarns.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(projectDir, { recursive: true, force: true });
	});

	function envLocal(): Record<string, string> {
		const file = writtenEnvFiles
			.filter((f) => f.path.endsWith(".env.local"))
			.at(-1);
		const env: Record<string, string> = {};
		for (const line of (file?.content ?? "").split("\n")) {
			const eq = line.indexOf("=");
			if (eq > 0)
				env[line.slice(0, eq)] = line.slice(eq + 1).replace(/^"|"$/g, "");
		}
		return env;
	}

	it("writes an empty value for every per-endpoint property while $app.* keeps its routing answer", async () => {
		writeFileSync(join(projectDir, "Launchfile"), GITEA_SHAPE);
		await launchUp({ projectDir });
		const env = envLocal();
		expect(env.ROOT_URL).toMatch(/^http:\/\/localhost:\d+$/);
		expect(env.WEB_URL).toBe("");
		expect(env.SSH_DOMAIN).toBe("");
		expect(env.SSH_PORT).toBe("");
	});

	it("warns once, naming the endpoints the file references", async () => {
		writeFileSync(join(projectDir, "Launchfile"), GITEA_SHAPE);
		await launchUp({ projectDir });
		const notes = consoleWarns.filter((w) => w.includes("$app.endpoints.*"));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("$app.endpoints.web.*");
		expect(notes[0]).toContain("$app.endpoints.ssh.*");
		expect(notes[0]).toContain("#294");
	});

	it("stays silent for a file that references no per-endpoint property", async () => {
		writeFileSync(
			join(projectDir, "Launchfile"),
			GITEA_SHAPE.replace(/\$app\.endpoints\.\w+\.\w+/g, "$app.url"),
		);
		await launchUp({ projectDir });
		expect(consoleWarns.some((w) => w.includes("$app.endpoints"))).toBe(false);
	});
});
