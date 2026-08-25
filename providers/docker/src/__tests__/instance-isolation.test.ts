/**
 * Instance identity and isolation (#240, D-59).
 *
 * A deployment's provider state key is the (app identity, instance label)
 * pair: `--name <label>` folds into the effective slug, and everything the
 * slug keys — state dir, compose project (⇒ volumes + network), port
 * allocations — follows. An existing state created from a different source is
 * refused, never silently adopted.
 *
 * The dry-run tests redirect $HOME to a temp dir (node:os.homedir() honors it
 * on POSIX) so the real ~/.launchfile is never touched. The dry-run path skips
 * the prereq check, so everything except the non-dry-run refusal runs without
 * docker.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPrereqs } from "../prereqs.js";
import { allocatePorts } from "../port-allocator.js";
import { dockerUp, ForeignSourceError } from "../provider.js";
import {
	composeProject,
	initState,
	instanceSlug,
	InvalidInstanceLabelError,
	saveState,
	stateDir,
} from "../state.js";

const prereqs = await checkPrereqs();

// it.runIf is a vitest-only API; the bun test runner doesn't provide it.
const itIfPrereqsOk = prereqs.ok ? it : it.skip;

const LAUNCHFILE = `version: launch/v1
name: isotest
image: alpine:3.20
commands:
  start: sleep 300
`;

describe("instanceSlug (D-59)", () => {
	it("returns the base slug unchanged when no label is given", () => {
		expect(instanceSlug("ghost")).toBe("ghost");
		expect(instanceSlug("ghost", undefined)).toBe("ghost");
	});

	it("qualifies the slug with the label", () => {
		expect(instanceSlug("ghost", "test")).toBe("ghost-test");
		expect(instanceSlug("ghost", "ghost-test")).toBe("ghost-ghost-test");
	});

	it("rejects a label that breaks the slug rules — never mangles it", () => {
		for (const label of ["Test", "te_st", "a b", "-a", ".x", "über"]) {
			expect(() => instanceSlug("ghost", label)).toThrow(InvalidInstanceLabelError);
		}
	});

	it("rejects a combined slug over the 63-char compose project limit", () => {
		const base = "a".repeat(40);
		expect(instanceSlug(base, "b".repeat(22))).toBe(`${base}-${"b".repeat(22)}`);
		expect(() => instanceSlug(base, "b".repeat(23))).toThrow(
			InvalidInstanceLabelError,
		);
	});
});

describe("dockerUp --dry-run instance isolation (#240)", () => {
	let prevHome: string | undefined;
	let prevDockerConfig: string | undefined;
	let tmpHome: string;
	let projectDir: string;
	let output: string[];
	let errors: string[];
	let restore: (() => void) | null = null;

	beforeEach(() => {
		prevHome = process.env.HOME;
		prevDockerConfig = process.env.DOCKER_CONFIG;
		tmpHome = mkdtempSync(join(tmpdir(), "lf-instance-home-"));
		// Docker's CLI plugins (compose v2) resolve via $DOCKER_CONFIG, which
		// defaults to $HOME/.docker — pin it to the real one before HOME moves,
		// or the prereq check stops finding compose.
		if (prevHome && !prevDockerConfig) {
			process.env.DOCKER_CONFIG = join(prevHome, ".docker");
		}
		process.env.HOME = tmpHome;
		projectDir = mkdtempSync(join(tmpdir(), "lf-instance-app-"));
		writeFileSync(join(projectDir, "Launchfile"), LAUNCHFILE);

		output = [];
		errors = [];
		const log = console.log;
		const err = console.error;
		console.log = (...args: unknown[]) => output.push(args.join(" "));
		console.error = (...args: unknown[]) => errors.push(args.join(" "));
		restore = () => {
			console.log = log;
			console.error = err;
		};
	});

	afterEach(() => {
		restore?.();
		restore = null;
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevDockerConfig === undefined) delete process.env.DOCKER_CONFIG;
		else process.env.DOCKER_CONFIG = prevDockerConfig;
		rmSync(tmpHome, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("keeps unnamed behavior unchanged: base slug, base state dir", async () => {
		const result = await dockerUp(projectDir, { dryRun: true });
		expect(result.slug).toBe("isotest");
		expect(stateDir("isotest")).toBe(
			join(tmpHome, ".launchfile", "docker", "isotest"),
		);
		expect(existsSync(stateDir("isotest"))).toBe(true);
	});

	it("gives two labels two distinct slugs, state dirs, and compose projects", async () => {
		const a = await dockerUp(projectDir, { dryRun: true, name: "a" });
		const b = await dockerUp(projectDir, { dryRun: true, name: "b" });

		expect(a.slug).toBe("isotest-a");
		expect(b.slug).toBe("isotest-b");
		expect(existsSync(stateDir("isotest-a"))).toBe(true);
		expect(existsSync(stateDir("isotest-b"))).toBe(true);
		expect(stateDir("isotest-a")).not.toBe(stateDir("isotest-b"));
		expect(composeProject(a.slug)).toBe("launchfile-isotest-a");
		expect(composeProject(b.slug)).toBe("launchfile-isotest-b");
		// The base slug's state is untouched by either.
		expect(existsSync(stateDir("isotest"))).toBe(false);
	});

	it("rejects an invalid label before anything exists", async () => {
		await expect(
			dockerUp(projectDir, { dryRun: true, name: "Bad_Label" }),
		).rejects.toThrow(InvalidInstanceLabelError);
		expect(existsSync(join(tmpHome, ".launchfile"))).toBe(false);
	});

	it("warns on a dry-run against state created from a different source", async () => {
		const foreign = initState("isotest", "isotest", LAUNCHFILE, {
			sourceType: "local",
			sourcePath: "/somewhere/else/Launchfile",
		});
		await saveState("isotest", foreign);

		await dockerUp(projectDir, { dryRun: true });
		const printed = errors.join("\n");
		expect(printed).toContain("already deployed from a different source");
		expect(printed).toContain("/somewhere/else/Launchfile");
		expect(printed).toContain("--name <label>");
	});

	it("does not warn when the same source re-ups its own state", async () => {
		const own = initState("isotest", "isotest", LAUNCHFILE, {
			sourceType: "local",
			sourcePath: join(projectDir, "Launchfile"),
		});
		await saveState("isotest", own);

		await dockerUp(projectDir, { dryRun: true });
		expect(errors.join("\n")).not.toContain("different source");
	});

	// The real refusal fires after the prereq check, so it needs docker.
	itIfPrereqsOk(
		"refuses (not adopts) a real launch against another source's state",
		async () => {
			const foreign = initState("isotest", "isotest", LAUNCHFILE, {
				sourceType: "local",
				sourcePath: "/somewhere/else/Launchfile",
			});
			await saveState("isotest", foreign);

			await expect(dockerUp(projectDir, {})).rejects.toThrow(ForeignSourceError);
			// The refusal names the project and the remedies.
			const err = await dockerUp(projectDir, {}).catch((e: unknown) => e as Error);
			expect(err).toBeInstanceOf(ForeignSourceError);
			expect((err as Error).message).toContain("launchfile-isotest");
			expect((err as Error).message).toContain("/somewhere/else/Launchfile");
			expect((err as Error).message).toContain("--name <label>");
			expect((err as Error).message).toContain("launchfile down isotest --destroy");
		},
	);

	it("accepts the same checkout spelled through a symlink — no false refusal", async () => {
		// projectDir came from mkdtemp under the platform tmpdir; a symlinked
		// spelling of the same directory must compare equal via realpath.
		const linked = join(tmpHome, "linked-app");
		const { symlinkSync } = await import("node:fs");
		symlinkSync(projectDir, linked);

		const own = initState("isotest", "isotest", LAUNCHFILE, {
			sourceType: "local",
			sourcePath: join(projectDir, "Launchfile"),
		});
		await saveState("isotest", own);

		await dockerUp(linked, { dryRun: true });
		expect(errors.join("\n")).not.toContain("different source");
	});
});

describe("foreign-source guard across source types (#240 review blocker)", () => {
	let prevHome: string | undefined;
	let prevDockerConfig: string | undefined;
	let tmpHome: string;
	let errors: string[];
	let restore: (() => void) | null = null;

	beforeEach(() => {
		prevHome = process.env.HOME;
		prevDockerConfig = process.env.DOCKER_CONFIG;
		tmpHome = mkdtempSync(join(tmpdir(), "lf-xsource-home-"));
		if (prevHome && !prevDockerConfig) {
			process.env.DOCKER_CONFIG = join(prevHome, ".docker");
		}
		process.env.HOME = tmpHome;

		errors = [];
		const log = console.log;
		const err = console.error;
		console.log = () => undefined;
		console.error = (...args: unknown[]) => errors.push(args.join(" "));
		restore = () => {
			console.log = log;
			console.error = err;
		};
	});

	afterEach(() => {
		restore?.();
		restore = null;
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevDockerConfig === undefined) delete process.env.DOCKER_CONFIG;
		else process.env.DOCKER_CONFIG = prevDockerConfig;
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("a catalog up over local-recorded state warns on dry-run — the reviewer's repro", async () => {
		// Slug "ghost" resolved from the repo's own catalog; its saved state
		// says a local checkout deployed it.
		const local = initState("ghost", "ghost", "name: ghost\n", {
			sourceType: "local",
			sourcePath: "/some/checkout/Launchfile",
		});
		await saveState("ghost", local);

		await dockerUp("ghost", { dryRun: true });
		const printed = errors.join("\n");
		expect(printed).toContain("already deployed from a different source");
		expect(printed).toContain("/some/checkout/Launchfile");
		expect(printed).toContain("the launchfile catalog");
	});

	itIfPrereqsOk(
		"a catalog up over local-recorded state refuses for real, with the teardown remedy",
		async () => {
			const local = initState("ghost", "ghost", "name: ghost\n", {
				sourceType: "local",
				sourcePath: "/some/checkout/Launchfile",
			});
			await saveState("ghost", local);

			const err = await dockerUp("ghost", { yes: true }).catch((e: unknown) => e as Error);
			expect(err).toBeInstanceOf(ForeignSourceError);
			expect((err as Error).message).toContain("/some/checkout/Launchfile");
			expect((err as Error).message).toContain("launchfile down ghost --destroy");
		},
	);

	it("a url up over a different recorded url warns on dry-run", async () => {
		const { createServer: createHttpServer } = await import("node:http");
		const server = createHttpServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/yaml" });
			res.end(LAUNCHFILE);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as { port: number };
		try {
			const recorded = initState("isotest", "isotest", LAUNCHFILE, {
				sourceType: "url",
				sourceUrl: "http://other.example/Launchfile",
			});
			await saveState("isotest", recorded);

			await dockerUp(`http://127.0.0.1:${address.port}/Launchfile`, { dryRun: true });
			const printed = errors.join("\n");
			expect(printed).toContain("already deployed from a different source");
			expect(printed).toContain("http://other.example/Launchfile");
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});

	it("a catalog up over catalog-recorded state proceeds — same source, no warning", async () => {
		const recorded = initState("ghost", "ghost", "name: ghost\n", {
			sourceType: "catalog",
		});
		await saveState("ghost", recorded);

		await dockerUp("ghost", { dryRun: true });
		expect(errors.join("\n")).not.toContain("different source");
	});

	it("pre-source-tracking state stays fail-open — no recorded source, no refusal", async () => {
		const legacy = initState("ghost", "ghost", "name: ghost\n");
		legacy.sourceType = undefined;
		legacy.sourcePath = undefined;
		legacy.sourceUrl = undefined;
		await saveState("ghost", legacy);

		await dockerUp("ghost", { dryRun: true });
		expect(errors.join("\n")).not.toContain("different source");
	});
});

describe("port allocation is seeded per instance (D-59, #275 interaction)", () => {
	let blocker: Server;

	beforeEach(async () => {
		// Occupy the declared container port so allocatePorts takes the
		// deterministic-fallback branch, where the seed matters.
		blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(28080, "127.0.0.1", resolve));
	});

	afterEach(async () => {
		await new Promise((resolve) => blocker.close(resolve));
	});

	it("two instances prefer distinct fallback ports before probing", async () => {
		const components = { default: { provides: [{ port: 28080, exposed: true }] } };

		const a = await allocatePorts(components, "isotest-a");
		const b = await allocatePorts(components, "isotest-b");

		// hash("isotest-a:default") → 18142 and hash("isotest-b:default") →
		// 14691: with the effective slug as seed, the two instances prefer
		// ports thousands apart instead of contending for one candidate.
		expect(a.default).not.toBe(b.default);
		expect(a.default).not.toBe(28080);
		expect(b.default).not.toBe(28080);
	});
});
