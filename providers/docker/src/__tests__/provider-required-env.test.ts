/**
 * The deploying branch of PROVIDERS.md §10 rule 8 in `dockerUp` (D-52).
 *
 * The AWS table has no verb for this — AWS never launches. What is pinned here
 * is the half a pure generator cannot express: that `up` fails by name, that it
 * fails BEFORE anything exists, that it does not prompt, and that the operator
 * channel actually works.
 *
 * `./shell.js` and `node:fs/promises` are mocked so every docker invocation and
 * every file write lands in a recorder — an empty recorder is the proof that
 * nothing was created.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const composeFile = "/tmp/launchfile-required-env/docker-compose.yml";

const calls: string[][] = [];
const writes: string[] = [];
const consoleLogs: string[] = [];

let yaml = "";

vi.mock("../source-resolver.js", () => ({
	resolveSource: async () => ({
		yaml,
		slug: "acme",
		source: "local" as const,
		dir: "/tmp/launchfile-required-env",
		path: "/tmp/launchfile-required-env/Launchfile",
	}),
}));

vi.mock("../prereqs.js", () => ({
	checkPrereqs: async () => ({ ok: true, missing: [] }),
	composeSupportsIgnoreBuildable: async () => true,
}));

vi.mock("../port-allocator.js", () => ({
	allocatePorts: async () => ({ web: 8080, worker: 8081, default: 8080 }),
	// Faithful re-implementation of the real key scheme: first published
	// endpoint keeps the bare component name, the rest get `component:name`
	// (or `component:port`). The factory cannot spread the real module — see
	// the `importOriginal` note below.
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

// A prompt here would be the rule-8 violation this test guards against: a
// non-interactive `up` must fail by name, never hang on stdin.
vi.mock("node:readline", () => ({
	createInterface: () => {
		throw new Error("dockerUp must not prompt on the unsupplied-required path");
	},
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
	stateBaseDir: () => "/tmp/launchfile-required-env/state",
	stateDir: (slug: string) => `/tmp/launchfile-required-env/state/${slug}`,
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

const { dockerUp, UnsuppliedRequiredEnvError } = await import("../provider.js");

const SINGLE = `
name: acme
image: acme/app:1
provides:
  - { protocol: http, port: 3000, exposed: true }
env:
  ADMIN_TOKEN:
    required: true
    sensitive: true
`;

const TWO_COMPONENTS = `
name: acme
components:
  web:
    image: acme/web:1
    provides:
      - { protocol: http, port: 3000, exposed: true }
  worker:
    image: acme/worker:1
    env:
      QUEUE_URL:
        required: true
`;

describe("dockerUp — unsupplied required env (PROVIDERS.md rule 8, D-52)", () => {
	beforeEach(() => {
		calls.length = 0;
		writes.length = 0;
		consoleLogs.length = 0;
		delete process.env.ADMIN_TOKEN;
		delete process.env.QUEUE_URL;
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			consoleLogs.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.ADMIN_TOKEN;
		delete process.env.QUEUE_URL;
	});

	// 9
	it("fails, naming both the component and the variable", async () => {
		yaml = TWO_COMPONENTS;
		const err = await dockerUp("Launchfile", {}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(UnsuppliedRequiredEnvError);
		expect((err as Error).message).toContain("worker");
		expect((err as Error).message).toContain("QUEUE_URL");
		expect((err as InstanceType<typeof UnsuppliedRequiredEnvError>).vars).toEqual([
			{ component: "worker", key: "QUEUE_URL", sensitive: false },
		]);
	});

	it("marks a sensitive variable without printing any value", async () => {
		yaml = SINGLE;
		const err = (await dockerUp("Launchfile", {}).catch(
			(e: unknown) => e,
		)) as InstanceType<typeof UnsuppliedRequiredEnvError>;
		expect(err.message).toContain("ADMIN_TOKEN (sensitive)");
		expect(err.vars[0]!.sensitive).toBe(true);
	});

	// 10
	it("succeeds when the value is present in process.env, and injects it", async () => {
		yaml = SINGLE;
		process.env.ADMIN_TOKEN = "s3cret-from-operator";
		await expect(dockerUp("Launchfile", { dryRun: true })).resolves.toMatchObject({
			slug: "acme",
		});
		const printed = consoleLogs.join("\n");
		expect(printed).toContain("ADMIN_TOKEN: s3cret-from-operator");
	});

	// 11
	it("does not block the launch for a component outside the start-set", async () => {
		yaml = TWO_COMPONENTS;
		await expect(dockerUp("Launchfile", { components: ["web"] })).resolves.toMatchObject({
			slug: "acme",
		});
		expect(calls.some((argv) => argv.includes("up"))).toBe(true);
	});

	// 12
	it("fails non-interactively rather than prompting", async () => {
		// `node:readline` throws if touched. Reaching the typed error instead
		// proves the fail branch was taken with no prompt and no stdin read.
		yaml = SINGLE;
		const err = await dockerUp("Launchfile", {}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(UnsuppliedRequiredEnvError);
	});

	// 13
	it("fails before any container, network, image, or compose file exists", async () => {
		yaml = SINGLE;
		await dockerUp("Launchfile", {}).catch(() => {});
		expect(calls).toEqual([]);
		expect(writes).toEqual([]);
	});

	it("does not fail for a component this provider skipped entirely", async () => {
		// A component with no image and no build generates no service, so it is
		// not being launched and its environment is not a launch-blocking gap.
		yaml = `
name: acme
components:
  web:
    image: acme/web:1
    provides:
      - { protocol: http, port: 3000, exposed: true }
  ghost:
    env:
      NEVER_USED:
        required: true
`;
		await expect(dockerUp("Launchfile", {})).resolves.toMatchObject({ slug: "acme" });
	});
});
