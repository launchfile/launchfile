/**
 * Wiring test for the D-48 release ordering in `dockerUp`.
 *
 * `planReleases`/`runReleases` are covered as pure units in release.test.ts.
 * What this file pins is the thing that was actually missing before #193: the
 * provider calling them at all, and calling them in the right place — after
 * the compose file is written, before `compose up` starts any app service.
 * `./shell.js` is mocked so every docker invocation, release one-shots
 * included, lands in one ordered recorder.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const composeFile = "/tmp/launchfile-release-wiring/docker-compose.yml";

const yaml = `
name: acme
components:
  app:
    image: acme/app:1
    provides:
      - { protocol: http, port: 3000, exposed: true }
    commands:
      release: "acme-migrate"
  sidecar:
    image: acme/sidecar:1
`;

const calls: string[][] = [];

vi.mock("../source-resolver.js", () => ({
	resolveSource: async () => ({
		yaml,
		slug: "acme",
		source: "local" as const,
		dir: "/tmp/launchfile-release-wiring",
		path: "/tmp/launchfile-release-wiring/Launchfile",
	}),
}));

vi.mock("../prereqs.js", () => ({
	checkPrereqs: async () => ({ ok: true, missing: [] }),
	composeSupportsIgnoreBuildable: async () => true,
}));

vi.mock("../port-allocator.js", () => ({
	allocatePorts: async () => ({ app: 8080 }),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	writeFile: async () => {},
}));

vi.mock("../state.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../state.js")>()),
	loadState: async () => null,
	saveState: async () => {},
	ensureStateDir: async () => {},
	composePath: () => composeFile,
}));

vi.mock("../shell.js", () => ({
	shell: async (cmd: string, args: string[]) => {
		calls.push([cmd, ...args]);
		// The health poll reads `compose ps --format json`.
		if (args.includes("ps")) {
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					State: "running",
					Health: "healthy",
					Name: "acme-app-1",
					Service: "acme-app",
				}),
				stderr: "",
			};
		}
		return { exitCode: 0, stdout: "", stderr: "" };
	},
	shellStream: async (cmd: string, args: string[]) => {
		calls.push([cmd, ...args]);
		return 0;
	},
	shellOk: async () => true,
}));

const { dockerUp } = await import("../provider.js");

const indexOfCall = (predicate: (argv: string[]) => boolean): number =>
	calls.findIndex(predicate);

describe("dockerUp release wiring", () => {
	beforeEach(() => {
		calls.length = 0;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("runs the declared release as a one-shot before `compose up`", async () => {
		await dockerUp("Launchfile", {});

		const release = indexOfCall(
			(argv) => argv.includes("run") && argv.includes("--rm"),
		);
		const up = indexOfCall((argv) => argv.includes("up") && argv.includes("-d"));

		expect(release).toBeGreaterThanOrEqual(0);
		expect(up).toBeGreaterThanOrEqual(0);
		expect(release).toBeLessThan(up);
		expect(calls[release]).toEqual([
			"docker",
			"compose",
			"-p",
			"launchfile-acme",
			"-f",
			composeFile,
			"run",
			"--rm",
			"-T",
			"acme-app",
			"sh",
			"-c",
			"acme-migrate",
		]);
	});

	it("does not run any release under --dry-run", async () => {
		await dockerUp("Launchfile", { dryRun: true });
		expect(indexOfCall((argv) => argv.includes("run"))).toBe(-1);
	});
});
