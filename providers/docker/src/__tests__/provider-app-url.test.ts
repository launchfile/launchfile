/**
 * dockerUp publication-context wiring (#290): a supplied `appUrl` resolves
 * `$app.*` for the run and replaces the recorded value; omission preserves
 * what state records (so a later plain `up` cannot silently flip a proxied
 * deployment back to localhost); a malformed value is refused before anything
 * is provisioned.
 *
 * Same harness as instance-isolation.test.ts: $HOME redirected to a temp dir
 * (node:os.homedir() honors it on POSIX) so the real ~/.launchfile is never
 * touched, and the dry-run path skips the prereq check, so everything here
 * runs without docker.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidAppUrlError } from "../app-url.js";
import { dockerUp } from "../provider.js";
import { initState, saveState } from "../state.js";

const LAUNCHFILE = `version: launch/v1
name: urltest
components:
  web:
    image: nginx:1.27
    provides:
      - port: 8080
        protocol: http
        exposed: true
    env:
      PUBLIC_URL:
        default: $app.url
      DOMAIN:
        default: $app.authority
`;

describe("dockerUp --dry-run appUrl (#290)", () => {
	let prevHome: string | undefined;
	let prevDockerConfig: string | undefined;
	let tmpHome: string;
	let projectDir: string;
	let output: string[];
	let restore: (() => void) | null = null;

	beforeEach(() => {
		prevHome = process.env.HOME;
		prevDockerConfig = process.env.DOCKER_CONFIG;
		tmpHome = mkdtempSync(join(tmpdir(), "lf-appurl-home-"));
		if (prevHome && !prevDockerConfig) {
			process.env.DOCKER_CONFIG = join(prevHome, ".docker");
		}
		process.env.HOME = tmpHome;
		projectDir = mkdtempSync(join(tmpdir(), "lf-appurl-app-"));
		writeFileSync(join(projectDir, "Launchfile"), LAUNCHFILE);

		output = [];
		const log = console.log;
		const err = console.error;
		console.log = (...args: unknown[]) => output.push(args.join(" "));
		console.error = (...args: unknown[]) => output.push(args.join(" "));
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

	async function seedState(appUrl?: string): Promise<void> {
		const state = initState("urltest", "urltest", LAUNCHFILE, {
			sourceType: "local",
			sourcePath: join(projectDir, "Launchfile"),
		});
		state.appUrl = appUrl;
		await saveState("urltest", state);
	}

	it("resolves $app.* from a supplied appUrl", async () => {
		await dockerUp(projectDir, {
			dryRun: true,
			appUrl: "https://notes.example.com",
		});
		const yaml = output.join("\n");
		expect(yaml).toContain("PUBLIC_URL: https://notes.example.com");
		expect(yaml).toContain("DOMAIN: notes.example.com");
		expect(yaml).not.toContain("PUBLIC_URL: http://localhost");
	});

	it("normalizes the supplied value before it reaches $app.*", async () => {
		await dockerUp(projectDir, {
			dryRun: true,
			appUrl: "HTTPS://Notes.Example.COM:443/",
		});
		expect(output.join("\n")).toContain(
			"PUBLIC_URL: https://notes.example.com",
		);
	});

	it("preserves the recorded appUrl when a later run omits the option", async () => {
		await seedState("https://notes.example.com");
		await dockerUp(projectDir, { dryRun: true });
		const yaml = output.join("\n");
		expect(yaml).toContain("PUBLIC_URL: https://notes.example.com");
		expect(yaml).not.toContain("PUBLIC_URL: http://localhost");
	});

	it("replaces the recorded appUrl when a different one is supplied (D-49)", async () => {
		await seedState("https://old.example.com");
		await dockerUp(projectDir, {
			dryRun: true,
			appUrl: "https://new.example.com",
		});
		const yaml = output.join("\n");
		expect(yaml).toContain("PUBLIC_URL: https://new.example.com");
		expect(yaml).not.toContain("old.example.com");
	});

	it("falls back to localhost routing when nothing is recorded or supplied", async () => {
		await dockerUp(projectDir, { dryRun: true });
		expect(output.join("\n")).toMatch(/PUBLIC_URL: http:\/\/localhost:\d+/);
	});

	it("refuses a malformed appUrl before anything exists — never a localhost fallback", async () => {
		await expect(
			dockerUp(projectDir, { dryRun: true, appUrl: "notes.example.com" }),
		).rejects.toThrow(InvalidAppUrlError);
		expect(existsSync(join(tmpHome, ".launchfile"))).toBe(false);
	});
});
