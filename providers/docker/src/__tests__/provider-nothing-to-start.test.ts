/**
 * `dockerUp` when refusal leaves nothing to start (D-64 rule 3, PROVIDERS.md
 * §10 item 5).
 *
 * Refusal is per component, so an app whose every selected component is
 * refused reaches the launch step with an empty service set. The provider
 * stops there itself: on `up`, compose given `services: {}` would fail with
 * its own error in place of the provider's; on `--dry-run`, an empty compose
 * file would print as if it were a valid plan.
 *
 * Same harness as provider-required-env.test.ts: `./shell.js` and
 * `node:fs/promises` are mocked so every docker invocation and every file
 * write lands in a recorder, and an empty recorder is the proof that compose
 * was never invoked and no compose file was written. The guard is keyed on
 * emptiness, not on a refusal kind, so two kinds are exercised: an
 * unprovisionable type (D-64) and a host capability (D-44).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const composeFile = "/tmp/launchfile-nothing-to-start/docker-compose.yml";

const calls: string[][] = [];
const writes: string[] = [];
const consoleLogs: string[] = [];
const consoleErrors: string[] = [];

let yaml = "";

vi.mock("../source-resolver.js", () => ({
	resolveSource: async () => ({
		yaml,
		slug: "acme",
		source: "local" as const,
		dir: "/tmp/launchfile-nothing-to-start",
		path: "/tmp/launchfile-nothing-to-start/Launchfile",
	}),
}));

vi.mock("../prereqs.js", () => ({
	checkPrereqs: async () => ({ ok: true, missing: [] }),
	composeSupportsIgnoreBuildable: async () => true,
}));

vi.mock("../port-allocator.js", () => ({
	allocatePorts: async () => ({ web: 8080, worker: 8081, default: 8080 }),
	publishedEndpoints: (
		component: string,
		provides?: {
			port: number;
			exposed?: boolean;
			name?: string;
			protocol?: string;
			bind?: string;
		}[],
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

vi.mock("node:fs/promises", () => ({
	writeFile: async (path: string) => {
		writes.push(String(path));
	},
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
	stateBaseDir: () => "/tmp/launchfile-nothing-to-start/state",
	stateDir: (slug: string) => `/tmp/launchfile-nothing-to-start/state/${slug}`,
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
	shellStream: async (cmd: string, args: string[]) => {
		calls.push([cmd, ...args]);
		return 0;
	},
	shellOk: async () => true,
}));

const { dockerUp, NothingToStartError } = await import("../provider.js");

/** One component, refused for an unprovisionable type (D-64). */
const UNPROVISIONABLE = `
name: acme
image: acme/app:1
requires:
  - type: snowflake
`;

/** One component, refused for a host capability (D-44). */
const HOST_CAPABILITY = `
name: acme
image: acme/app:1
requires:
  - host: { container_runtime: docker }
`;

/** Two components, each refused for a different reason. */
const BOTH_REFUSED = `
name: acme
components:
  web:
    image: acme/web:1
    requires:
      - type: snowflake
  worker:
    image: acme/worker:1
    requires:
      - host: { privileged: true }
`;

/** One refused, one that launches — the guard must stay silent. */
const ONE_SURVIVES = `
name: acme
components:
  web:
    image: acme/web:1
    provides:
      - { protocol: http, port: 3000, exposed: true }
  worker:
    image: acme/worker:1
    requires:
      - type: snowflake
`;

describe("dockerUp — every selected component refused (D-64 rule 3)", () => {
	beforeEach(() => {
		calls.length = 0;
		writes.length = 0;
		consoleLogs.length = 0;
		consoleErrors.length = 0;
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			consoleLogs.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			consoleErrors.push(args.map(String).join(" "));
		});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe.each([
		[
			"an unprovisionable type (D-64)",
			UNPROVISIONABLE,
			"requires a resource this provider cannot provision (snowflake)",
		],
		[
			"a host capability (D-44)",
			HOST_CAPABILITY,
			"requires host capabilities this provider cannot grant (container_runtime=docker)",
		],
	])("refused for %s", (_kind, launchfile, refusalText) => {
		it("up: prints the refusal, then fails without writing a compose file or running compose", async () => {
			yaml = launchfile;
			const err = await dockerUp("Launchfile", {}).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(NothingToStartError);
			expect((err as Error).message).toBe(
				"nothing to start: every selected component was refused or skipped",
			);
			expect(consoleErrors.join("\n")).toContain(
				`Refused: default ${refusalText}`,
			);
			expect(calls).toEqual([]);
			expect(writes).toEqual([]);
		});

		it("--dry-run: fails the same way instead of printing an empty compose file as a plan", async () => {
			yaml = launchfile;
			const err = await dockerUp("Launchfile", { dryRun: true }).catch(
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(NothingToStartError);
			expect(consoleErrors.join("\n")).toContain(
				`Refused: default ${refusalText}`,
			);
			expect(consoleLogs.join("\n")).not.toContain("docker-compose.yml");
			expect(consoleLogs.join("\n")).not.toContain("services: {}");
			expect(calls).toEqual([]);
			expect(writes).toEqual([]);
		});
	});

	it("fires when two components are refused for two different reasons", async () => {
		yaml = BOTH_REFUSED;
		const err = await dockerUp("Launchfile", {}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(NothingToStartError);
		expect(consoleErrors.filter((l) => l.includes("Refused:"))).toHaveLength(2);
		expect(calls).toEqual([]);
		expect(writes).toEqual([]);
	});

	it("fires when the selector's start-set is refused, even though an unselected sibling could start", async () => {
		yaml = ONE_SURVIVES;
		const err = await dockerUp("Launchfile", { components: ["worker"] }).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(NothingToStartError);
		expect(calls).toEqual([]);
		expect(writes).toEqual([]);
	});

	it("stays silent when a sibling survives — the refusal is per component", async () => {
		yaml = ONE_SURVIVES;
		await expect(dockerUp("Launchfile", {})).resolves.toMatchObject({
			slug: "acme",
		});
		expect(consoleErrors.join("\n")).toContain("Refused: worker ");
		expect(calls.some((argv) => argv.includes("up"))).toBe(true);
		expect(writes).toEqual([composeFile]);
	});

	it("is an expected refusal, not a crash", () => {
		expect(new NothingToStartError().expectedRefusal).toBe(true);
	});
});
