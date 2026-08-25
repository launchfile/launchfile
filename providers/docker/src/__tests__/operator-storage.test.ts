/**
 * The D-50 `content: operator` channel in the compose generator and in
 * `dockerUp` (#281).
 *
 * Rule 2's four rows, in generator terms: a marked volume with a supplied path
 * becomes a bind mount; with no path its mount is withheld and the volume
 * recorded for the caller to refuse; a supplied-but-absent path is refused by
 * `dockerUp` before anything exists; an unmarked volume is byte-identical to
 * today. Key resolution splits on the first dot — a left half naming no
 * component keeps the whole key as a volume name.
 *
 * The dockerUp tests redirect $HOME to a temp dir (node:os.homedir() honors it
 * on POSIX) so the real ~/.launchfile is never touched; everything runs
 * --dry-run, so no docker is needed past the prereq check.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaunch } from "@launchfile/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchToCompose } from "../compose-generator.js";
import { checkPrereqs } from "../prereqs.js";
import {
	dockerUp,
	MissingOperatorStoragePathError,
	UnboundOperatorStorageError,
} from "../provider.js";

const prereqs = await checkPrereqs();

// it.runIf is a vitest-only API; the bun test runner doesn't provide it.
const itIfPrereqsOk = prereqs.ok ? it : it.skip;

const MARKED = `
name: media
image: navidrome:latest
storage:
  music:
    path: /music
    content: operator
    persistent: true
  data:
    path: /data
`;

describe("launchToCompose content: operator (D-50)", () => {
	it("binds a supplied path instead of creating a named volume (row 1)", () => {
		const launch = readLaunch(MARKED);
		const result = launchToCompose(launch, { storagePaths: { music: "/srv/music" } });

		expect(result.yaml).toContain("/srv/music:/music");
		// The marked volume creates NO named volume; the unmarked one still does.
		expect(result.yaml).not.toContain("media-music");
		expect(result.yaml).toContain("media-data:/data");
		expect(result.storageBinds).toEqual([
			{
				component: "default",
				volume: "music",
				key: "music",
				hostPath: "/srv/music",
				containerPath: "/music",
			},
		]);
		expect(result.unboundOperatorVolumes).toEqual([]);
	});

	it("withholds the mount and records the volume when no path covers it (row 2)", () => {
		const launch = readLaunch(MARKED);
		const result = launchToCompose(launch);

		expect(result.unboundOperatorVolumes).toEqual([
			{ component: "default", volume: "music", flag: "--storage music=<path>" },
		]);
		// Never a fabricated empty volume, and no mount at its container path.
		expect(result.yaml).not.toContain("media-music");
		expect(result.yaml).not.toContain(":/music");
	});

	it("leaves an unmarked launch byte-identical whether or not storagePaths is passed (row 4)", () => {
		const yaml = `
name: plain
image: nginx
storage:
  data:
    path: /data
`;
		const without = launchToCompose(readLaunch(yaml));
		const withMap = launchToCompose(readLaunch(yaml), {
			storagePaths: { data: "/srv/data" },
		});
		expect(withMap.yaml).toBe(without.yaml);
		// The key bound nothing (only marked volumes are bindable) and says so.
		expect(withMap.warnings).toContain(
			"--storage data matches no `content: operator` volume — ignored",
		);
		expect(without.warnings).toHaveLength(0);
	});

	it("keeps $storage.<name>.path resolving to the container path under a bind (D-39)", () => {
		const launch = readLaunch(`
name: media
image: navidrome:latest
storage:
  music:
    path: /music
    content: operator
env:
  ND_MUSICFOLDER: $storage.music.path
`);
		const result = launchToCompose(launch, { storagePaths: { music: "/srv/music" } });
		expect(result.yaml).toContain("ND_MUSICFOLDER: /music");
	});

	describe("first-dot key disambiguation", () => {
		const TWO_COMPONENTS = `
name: shelf
components:
  web:
    image: shelf:latest
    storage:
      library:
        path: /library
        content: operator
  sync:
    image: syncer:latest
    storage:
      library:
        path: /import
        content: operator
`;

		it("routes component.volume keys to that component only", () => {
			const launch = readLaunch(TWO_COMPONENTS);
			const result = launchToCompose(launch, {
				storagePaths: { "web.library": "/srv/books", "sync.library": "/srv/inbox" },
			});
			expect(result.yaml).toContain("/srv/books:/library");
			expect(result.yaml).toContain("/srv/inbox:/import");
			expect(result.unboundOperatorVolumes).toEqual([]);
		});

		it("binds a bare volume name to every component declaring it", () => {
			const launch = readLaunch(TWO_COMPONENTS);
			const result = launchToCompose(launch, { storagePaths: { library: "/srv/shared" } });
			expect(result.yaml).toContain("/srv/shared:/library");
			expect(result.yaml).toContain("/srv/shared:/import");
		});

		it("prefers the component-qualified key over a bare one for the same volume", () => {
			const launch = readLaunch(TWO_COMPONENTS);
			const result = launchToCompose(launch, {
				storagePaths: { library: "/srv/shared", "web.library": "/srv/books" },
			});
			expect(result.yaml).toContain("/srv/books:/library");
			expect(result.yaml).toContain("/srv/shared:/import");
		});

		it("suggests the component.volume flag when the bare name is ambiguous", () => {
			const launch = readLaunch(TWO_COMPONENTS);
			const result = launchToCompose(launch);
			expect(result.unboundOperatorVolumes).toEqual([
				{ component: "web", volume: "library", flag: "--storage web.library=<path>" },
				{ component: "sync", volume: "library", flag: "--storage sync.library=<path>" },
			]);
		});

		it("treats a dotted key whose left half names no component as a volume name", () => {
			const launch = readLaunch(`
name: dotted
image: app:1
storage:
  drop.box:
    path: /drop
    content: operator
`);
			const result = launchToCompose(launch, {
				storagePaths: { "drop.box": "/srv/drop" },
			});
			expect(result.yaml).toContain("/srv/drop:/drop");
			expect(result.unboundOperatorVolumes).toEqual([]);
			expect(result.warnings).toHaveLength(0);
		});
	});
});

describe("dockerUp --dry-run operator storage (D-50)", () => {
	let prevHome: string | undefined;
	let prevDockerConfig: string | undefined;
	let tmpHome: string;
	let projectDir: string;
	let contentDir: string;
	let output: string[];
	let restore: (() => void) | null = null;

	const LAUNCHFILE = `version: launch/v1
name: opstore
image: navidrome:latest
storage:
  music:
    path: /music
    content: operator
    persistent: true
commands:
  start: sleep 300
`;

	beforeEach(() => {
		prevHome = process.env.HOME;
		prevDockerConfig = process.env.DOCKER_CONFIG;
		tmpHome = mkdtempSync(join(tmpdir(), "lf-opstore-home-"));
		// Docker's CLI plugins (compose v2) resolve via $DOCKER_CONFIG, which
		// defaults to $HOME/.docker — pin it to the real one before HOME moves.
		if (prevHome && !prevDockerConfig) {
			process.env.DOCKER_CONFIG = join(prevHome, ".docker");
		}
		process.env.HOME = tmpHome;
		projectDir = mkdtempSync(join(tmpdir(), "lf-opstore-app-"));
		contentDir = mkdtempSync(join(tmpdir(), "lf-opstore-content-"));
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
		rmSync(contentDir, { recursive: true, force: true });
	});

	itIfPrereqsOk("refuses an unbound marked volume, naming volume and flag (row 2)", async () => {
		await expect(dockerUp(projectDir, { dryRun: true })).rejects.toThrow(
			UnboundOperatorStorageError,
		);
		await expect(dockerUp(projectDir, { dryRun: true })).rejects.toThrow(
			/music.*--storage music=<path>/s,
		);
	});

	itIfPrereqsOk("emits the bind mount when the path is supplied (row 1)", async () => {
		await dockerUp(projectDir, { dryRun: true, storage: { music: contentDir } });
		expect(output.join("\n")).toContain(`${contentDir}:/music`);
	});

	itIfPrereqsOk("absolutizes a relative path against the cwd", async () => {
		const prevCwd = process.cwd();
		process.chdir(contentDir);
		try {
			await dockerUp(projectDir, { dryRun: true, storage: { music: "." } });
		} finally {
			process.chdir(prevCwd);
		}
		expect(output.join("\n")).toContain(`${contentDir}:/music`);
	});

	itIfPrereqsOk("refuses a supplied path that does not exist — never creates it (row 3)", async () => {
		const missing = join(contentDir, "no-such-dir");
		await expect(
			dockerUp(projectDir, { dryRun: true, storage: { music: missing } }),
		).rejects.toThrow(MissingOperatorStoragePathError);
		// The refusal did not create the directory.
		const { existsSync } = await import("node:fs");
		expect(existsSync(missing)).toBe(false);
	});

	itIfPrereqsOk("a named instance binds too, under the effective slug (D-55 interplay)", async () => {
		const result = await dockerUp(projectDir, {
			dryRun: true,
			name: "test-x",
			storage: { music: contentDir },
		});
		expect(result.slug).toBe("opstore-test-x");
		expect(output.join("\n")).toContain(`${contentDir}:/music`);
	});
});
