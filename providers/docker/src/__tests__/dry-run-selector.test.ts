/**
 * `dockerUp --dry-run` under a component selector (#403, D-41).
 *
 * The compose file is always the whole project — `down` and `logs` read the
 * persisted copy later — so a dry run prints it whole and names the start-set
 * beside it instead of narrowing the YAML. The start-set comes from the
 * selection closure, not the ports map: the "reachable at" summary skips a
 * component with no published port, so a port-less closure member (`api`
 * below) would otherwise be invisible.
 *
 * Same harness as provider-app-url.test.ts: $HOME redirected to a temp dir so
 * the real ~/.launchfile is never touched, and the dry-run path skips the
 * prereq check, so everything here runs without docker.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dockerUp, selectionLines } from "../provider.js";

/**
 * `web` depends on `api`, which publishes nothing; `worker` is unrelated and
 * publishes a port of its own.
 */
const LAUNCHFILE = `version: launch/v1
name: seltest
components:
  web:
    image: nginx:1.27
    provides:
      - port: 8080
        protocol: http
        exposed: true
    depends_on:
      - component: api
  api:
    image: acme/api:1
  worker:
    image: acme/worker:1
    provides:
      - port: 9090
        protocol: http
        exposed: true
`;

describe("dockerUp --dry-run with a component selector (#403)", () => {
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
		tmpHome = mkdtempSync(join(tmpdir(), "lf-selector-home-"));
		if (prevHome && !prevDockerConfig) {
			process.env.DOCKER_CONFIG = join(prevHome, ".docker");
		}
		process.env.HOME = tmpHome;
		projectDir = mkdtempSync(join(tmpdir(), "lf-selector-app-"));
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
		vi.restoreAllMocks();
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevDockerConfig === undefined) delete process.env.DOCKER_CONFIG;
		else process.env.DOCKER_CONFIG = prevDockerConfig;
		rmSync(tmpHome, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("prints the whole project file, labelled, and names the closure beside it", async () => {
		await dockerUp(projectDir, { dryRun: true, components: ["web"] });
		const text = output.join("\n");

		// The YAML is not narrowed: the unselected service is still in it.
		expect(text).toContain("--- docker-compose.yml (full project file) ---");
		expect(text).toContain("seltest-worker:");
		expect(text).toContain("seltest-api:");
		expect(text).toContain("seltest-web:");

		// The start-set is the D-41 closure, so the port-less `api` is named.
		expect(text).toContain("Selector: web");
		expect(text).toContain("Would start: api, web");
		expect(text).toContain("Not started: worker");

		// The address summary covers the closure only, in the dry-run tense.
		expect(text).toMatch(
			/ {2}web would be reachable at http:\/\/localhost:\d+/,
		);
		expect(text).not.toContain("worker would be reachable at");
		expect(text).not.toContain("is running at");
	});

	it("says none stays down when the selector covers every component", async () => {
		await dockerUp(projectDir, { dryRun: true, components: ["web", "worker"] });
		const text = output.join("\n");
		expect(text).toContain("Selector: web, worker");
		expect(text).toContain("Would start: api, web, worker");
		expect(text).toContain("Not started: none");
	});

	it("keeps the plain header and prints no start-set without a selector", async () => {
		await dockerUp(projectDir, { dryRun: true });
		const text = output.join("\n");
		expect(text).toContain("\n--- docker-compose.yml ---\n");
		expect(text).not.toContain("full project file");
		expect(text).not.toContain("Selector:");
		expect(text).not.toContain("Would start:");
		expect(text).not.toContain("Not started:");
		expect(text).toMatch(
			/ {2}web would be reachable at http:\/\/localhost:\d+/,
		);
		expect(text).toMatch(
			/ {2}worker would be reachable at http:\/\/localhost:\d+/,
		);
		expect(text).not.toContain("is running at");
	});

	it("refuses an unknown selector before printing any plan", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(((
			code?: number,
		) => {
			throw new Error(`exit ${code}`);
		}) as never);
		await expect(
			dockerUp(projectDir, { dryRun: true, components: ["nope"] }),
		).rejects.toThrow("exit 1");
		expect(exit).toHaveBeenCalledWith(1);
		expect(errors.join("\n")).toContain("Cannot select: nope");
		expect(errors.join("\n")).toContain(
			'"nope" matches no component. Available: web, api, worker',
		);
		expect(output.join("\n")).not.toContain("docker-compose.yml");
		expect(output.join("\n")).not.toContain("Would start:");
	});
});

describe("selectionLines", () => {
	it("names the selector, the closure and the rest", () => {
		expect(
			selectionLines(["web"], ["api", "web"], ["web", "api", "worker"]),
		).toEqual([
			"Selector: web",
			"Would start: api, web",
			"Not started: worker",
		]);
	});

	it("prints none when nothing stays down", () => {
		expect(
			selectionLines(
				["web", "worker"],
				["api", "web", "worker"],
				["web", "api", "worker"],
			),
		).toEqual([
			"Selector: web, worker",
			"Would start: api, web, worker",
			"Not started: none",
		]);
	});

	it("lists a selected-but-refused component as not started", () => {
		// A closure member the run refused earlier is not in `wouldStart`, so it
		// lands in the rest rather than being promised.
		expect(selectionLines(["web"], ["web"], ["web", "api"])).toEqual([
			"Selector: web",
			"Would start: web",
			"Not started: api",
		]);
	});
});
