/**
 * Wiring test for the two init-only advisories in `dockerUp`.
 *
 * `initOnlyExtensionsWarning` and `initOnlyDatabasesWarning` are pure string
 * builders, and pg-extensions-init-only.test.ts covers them and
 * `composeVolumeName` in isolation. What this file pins is the caller: that
 * `dockerUp` probes for the data volume, pushes each warning into
 * `result.warnings` only when the volume exists, issues no `docker volume ls`
 * on a dry run, and skips components that are not in the start-set.
 * `./shell.js` is mocked, so `docker volume ls` is answered from `volumes`
 * and every call lands in one recorder.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const composeFile = "/tmp/launchfile-init-only-wiring/docker-compose.yml";

// `worker` owns the postgres service (the generator attributes a pooled
// service to the first component that requires it); `web` needs no database.
const yaml = `
name: acme
components:
  web:
    image: acme/web:1
    provides:
      - { protocol: http, port: 3000, exposed: true }
  worker:
    image: acme/worker:1
    requires:
      - type: postgres
        config:
          extensions: [pgvector]
        uses: [{ database: reports }]
`;

const calls: string[][] = [];
// Volume keys (the `label=com.docker.compose.volume=<key>` filter value) that
// exist on the fake host; the answer to `docker volume ls` is derived from it.
const volumes = new Set<string>();

vi.mock("../source-resolver.js", () => ({
	resolveSource: async () => ({
		yaml,
		slug: "acme",
		source: "local" as const,
		dir: "/tmp/launchfile-init-only-wiring",
		path: "/tmp/launchfile-init-only-wiring/Launchfile",
	}),
}));

vi.mock("../prereqs.js", () => ({
	checkPrereqs: async () => ({ ok: true, missing: [] }),
	composeSupportsIgnoreBuildable: async () => true,
}));

vi.mock("../port-allocator.js", () => ({
	allocatePorts: async () => ({ web: 8080 }),
	// Faithful re-implementation of the real key scheme (bare component name
	// for the primary, `component:name` / `component:port` for the rest) —
	// the factory cannot spread the real module, see the note below.
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

// Both factories list every export the code under test pulls, rather than
// spreading the real module via vitest's `importOriginal`. The suite runs under
// `vitest run` (`bun run test`; ci.yml, the providers matrix). bunfig.toml's
// test-guard blocks a bare `bun test`, whose `vi.mock` passes no
// `importOriginal` argument.
vi.mock("node:fs/promises", () => ({
	writeFile: async () => {},
	readdir: async () => [],
	rm: async () => {},
}));

vi.mock("../state.js", () => ({
	loadState: async () => null,
	instanceSlug: (baseSlug: string, label?: string) =>
		label ? `${baseSlug}-${label}` : baseSlug,
	saveState: async () => {},
	ensureStateDir: async () => {},
	composePath: () => composeFile,
	composeProject: (slug: string) => `launchfile-${slug}`,
	stateBaseDir: () => "/tmp/launchfile-init-only-wiring/state",
	stateDir: (slug: string) => `/tmp/launchfile-init-only-wiring/state/${slug}`,
	initState: (slug: string, appName: string) => ({
		version: 1,
		slug,
		appName,
		composeProject: `launchfile-${slug}`,
		launchfileHash: "test",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		secrets: {},
		ports: {},
	}),
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
					Name: "acme-web-1",
					Service: "acme-web",
				}),
				stderr: "",
			};
		}
		if (args[0] === "volume" && args[1] === "ls") {
			const key = args
				.find((a) => a.startsWith("label=com.docker.compose.volume="))
				?.split("=")
				.slice(2)
				.join("=");
			return {
				exitCode: 0,
				stdout: key !== undefined && volumes.has(key) ? `launchfile-acme_${key}\n` : "",
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

const volumeKey = "acme-postgres-data";
const volumeName = `launchfile-acme_${volumeKey}`;

const volumeLsCalls = (): string[][] =>
	calls.filter((argv) => argv[1] === "volume" && argv[2] === "ls");

/** The advisories `dockerUp` printed, via its `Warning:` console line. */
const printedWarnings = (): string[] =>
	vi
		.mocked(console.warn)
		.mock.calls.map((args) => String(args[0]))
		.filter((line) => line.startsWith("  Warning: "));

const extensionWarnings = (): string[] =>
	printedWarnings().filter((w) => w.includes("config.extensions"));

const databaseWarnings = (): string[] =>
	printedWarnings().filter((w) => w.includes("named database uses"));

describe("dockerUp init-only warning wiring", () => {
	beforeEach(() => {
		calls.length = 0;
		volumes.clear();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("warns for both advisories, naming the project-scoped volume, when the data volume exists", async () => {
		volumes.add(volumeKey);
		await dockerUp("Launchfile", {});

		const ext = extensionWarnings();
		const dbs = databaseWarnings();
		expect(ext).toHaveLength(1);
		expect(ext[0]).toContain("acme-postgres: config.extensions (vector)");
		expect(ext[0]).toContain(`Volume ${volumeName} already exists`);
		expect(dbs).toHaveLength(1);
		expect(dbs[0]).toContain("acme-postgres: the named database uses (acme_reports)");
		expect(dbs[0]).toContain(`Volume ${volumeName} already exists`);
	});

	it("reports neither advisory when the data volume is absent", async () => {
		await dockerUp("Launchfile", {});

		expect(volumeLsCalls().length).toBeGreaterThan(0);
		expect(extensionWarnings()).toEqual([]);
		expect(databaseWarnings()).toEqual([]);
	});

	it("issues no `docker volume ls` and warns of nothing under --dry-run, even with the volume present", async () => {
		volumes.add(volumeKey);
		await dockerUp("Launchfile", { dryRun: true });

		expect(volumeLsCalls()).toEqual([]);
		expect(extensionWarnings()).toEqual([]);
		expect(databaseWarnings()).toEqual([]);
	});

	it("skips a component outside the start-set: no probe and no warning for its volume", async () => {
		volumes.add(volumeKey);
		await dockerUp("Launchfile", { components: ["web"] });

		expect(volumeLsCalls()).toEqual([]);
		expect(extensionWarnings()).toEqual([]);
		expect(databaseWarnings()).toEqual([]);
	});

	it("probes and warns once the owning component is selected", async () => {
		volumes.add(volumeKey);
		await dockerUp("Launchfile", { components: ["worker"] });

		expect(volumeLsCalls().length).toBeGreaterThan(0);
		expect(extensionWarnings()).toHaveLength(1);
		expect(databaseWarnings()).toHaveLength(1);
	});
});
