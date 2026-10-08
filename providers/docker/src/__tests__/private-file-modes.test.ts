/**
 * `dockerUp` tightens the files it writes into the state dir (#683, CWE-276).
 *
 * `writeFile`'s `mode` option applies only on create, so a compose file or
 * `state.json` left at 0o644 by an earlier version stayed readable by other
 * users. Both now go through `writePrivateFile`, which chmods the open handle
 * before writing. This file runs the REAL `state.js` against a temp `$HOME`
 * and asserts the on-disk mode after a real `up`; the only mocks are the ones
 * that would otherwise reach a live Docker (`shell.js`, `prereqs.js`,
 * `port-allocator.js`) and the source resolver.
 *
 * The loose mode is set with an explicit `chmod`, never through a `mode`
 * option: a strict umask on the runner masks that option and the test would
 * pass without testing anything (#410).
 */

import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let yaml = "";
let projectDir = "";

vi.mock("../source-resolver.js", () => ({
	resolveSource: async () => ({
		yaml,
		slug: "acme",
		source: "local" as const,
		dir: projectDir,
		path: join(projectDir, "Launchfile"),
	}),
}));

vi.mock("../prereqs.js", () => ({
	checkPrereqs: async () => ({ ok: true, missing: [] }),
	composeSupportsIgnoreBuildable: async () => true,
}));

vi.mock("../port-allocator.js", () => ({
	allocatePorts: async () => ({ web: 8080, default: 8080 }),
	publishedEndpoints: (
		component: string,
		provides?: { port: number; exposed?: boolean; name?: string; protocol?: string; bind?: string }[],
	) =>
		(provides?.filter((p) => p.exposed === true) ?? []).map((p, index) => ({
			key: index === 0 ? component : `${component}:${p.name ?? p.port}`,
			component,
			name: p.name,
			port: p.port,
			protocol: p.protocol,
			bind: p.bind,
		})),
}));

vi.mock("../shell.js", () => ({
	shell: async (_cmd: string, args: string[]) => {
		if (args.includes("ps")) {
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					State: "running",
					Health: "healthy",
					Name: "acme-web-1",
					Service: "acme-web",
				}),
				stderr: "",
			};
		}
		return { exitCode: 0, stdout: "", stderr: "" };
	},
	shellStream: async () => 0,
	shellOk: async () => true,
}));

const { dockerUp } = await import("../provider.js");
const { composePath, ensureStateDir, initState, saveState, stateDir } = await import("../state.js");

const LAUNCHFILE = `
name: acme
components:
  web:
    image: acme/web:1
    provides:
      - { protocol: http, port: 3000, exposed: true }
`;

// state.ts keys everything off homedir() → ~/.launchfile/docker/<slug>, and
// node:os.homedir() honors $HOME on POSIX.
let prevHome: string | undefined;
let tmpHome: string;

const mode = (path: string) => statSync(path).mode & 0o777;

describe("dockerUp — state dir files are tightened on overwrite (#683, CWE-276)", () => {
	beforeEach(() => {
		prevHome = process.env.HOME;
		tmpHome = mkdtempSync(join(tmpdir(), "lf-docker-modes-home-"));
		process.env.HOME = tmpHome;
		projectDir = mkdtempSync(join(tmpdir(), "lf-docker-modes-project-"));
		writeFileSync(join(projectDir, "Launchfile"), LAUNCHFILE);
		yaml = LAUNCHFILE;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		rmSync(tmpHome, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("rewrites a 0o644 compose file and state.json at 0o600", async () => {
		await ensureStateDir("acme");
		await saveState("acme", initState("acme", "acme", LAUNCHFILE));
		const compose = composePath("acme");
		const state = join(stateDir("acme"), "state.json");
		writeFileSync(compose, "services: {}\n");
		chmodSync(compose, 0o644);
		chmodSync(state, 0o644);
		expect(mode(compose)).toBe(0o644);
		expect(mode(state)).toBe(0o644);

		await expect(dockerUp("Launchfile", {})).resolves.toMatchObject({ slug: "acme" });

		expect(mode(compose)).toBe(0o600);
		expect(mode(state)).toBe(0o600);
	});

	it("creates both files at 0o600 on a first up", async () => {
		await expect(dockerUp("Launchfile", {})).resolves.toMatchObject({ slug: "acme" });

		expect(mode(composePath("acme"))).toBe(0o600);
		expect(mode(join(stateDir("acme"), "state.json"))).toBe(0o600);
	});
});
