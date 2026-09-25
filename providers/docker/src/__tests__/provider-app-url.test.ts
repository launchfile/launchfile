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

/** A declared `https-origin` naming a `ws` endpoint that is not the first. */
const DECLARED_WS = `version: launch/v1
name: livetest
components:
  web:
    image: nginx:1.27
    provides:
      - name: ui
        port: 8080
        protocol: http
        exposed: true
      - name: live
        port: 8081
        protocol: ws
        exposed: true
    supports:
      - type: https-origin
        endpoint: live
    env:
      APP_URL:
        default: $app.url
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

	it("prints the supplied URL in the up summary — the same value $app.url resolved to (#386)", async () => {
		await dockerUp(projectDir, {
			dryRun: true,
			appUrl: "https://notes.example.com",
		});
		const text = output.join("\n");
		expect(text).toContain("PUBLIC_URL: https://notes.example.com");
		expect(text).toContain("  web is running at https://notes.example.com");
		expect(text).not.toMatch(/web is running at http:\/\/localhost/);
	});

	it("prints the recorded URL on a later run that omits the option (#386)", async () => {
		await seedState("https://notes.example.com");
		await dockerUp(projectDir, { dryRun: true });
		expect(output.join("\n")).toContain(
			"  web is running at https://notes.example.com",
		);
	});

	it("prints the supplied URL on a ws endpoint a declared https-origin names (#386, D-60 rule 4)", async () => {
		writeFileSync(join(projectDir, "Launchfile"), DECLARED_WS);
		await dockerUp(projectDir, {
			dryRun: true,
			appUrl: "https://live.example.com",
		});
		const text = output.join("\n");
		expect(text).toContain("APP_URL: https://live.example.com");
		expect(text).toContain(
			"  web (live) is running at https://live.example.com",
		);
		expect(text).toMatch(/ {2}web is running at http:\/\/localhost:\d+/);
	});

	it("keeps ws://localhost on a ws primary no https-origin names (#386)", async () => {
		writeFileSync(
			join(projectDir, "Launchfile"),
			DECLARED_WS.replace(/ {4}supports:[\s\S]*?endpoint: live\n/, "").replace(
				/ {6}- name: ui\n {8}port: 8080\n {8}protocol: http\n {8}exposed: true\n/,
				"",
			),
		);
		await dockerUp(projectDir, {
			dryRun: true,
			appUrl: "https://live.example.com",
		});
		const text = output.join("\n");
		expect(text).toContain("APP_URL: https://live.example.com");
		expect(text).toMatch(/ {2}web is running at ws:\/\/localhost:\d+/);
		expect(text).not.toContain("is running at https://live.example.com");
	});

	it("prints localhost in the up summary when no URL is recorded or supplied", async () => {
		await dockerUp(projectDir, { dryRun: true });
		expect(output.join("\n")).toMatch(
			/ {2}web is running at http:\/\/localhost:\d+/,
		);
	});

	it("refuses a malformed appUrl before anything exists — never a localhost fallback", async () => {
		await expect(
			dockerUp(projectDir, { dryRun: true, appUrl: "notes.example.com" }),
		).rejects.toThrow(InvalidAppUrlError);
		expect(existsSync(join(tmpHome, ".launchfile"))).toBe(false);
	});
});
