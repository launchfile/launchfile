import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	initState,
	saveState,
	loadState,
	loadDockerSource,
	stateDir,
	type DockerState,
} from "../state.js";

// state.ts keys everything off homedir() → ~/.launchfile/docker/<slug>.
// node:os.homedir() honors $HOME on POSIX, so redirect it to a temp dir to
// keep the real ~/.launchfile untouched.
let prevHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
	prevHome = process.env.HOME;
	tmpHome = mkdtempSync(join(tmpdir(), "lf-docker-state-"));
	process.env.HOME = tmpHome;
});

afterEach(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("docker state — source persistence (#25)", () => {
	it("round-trips sourcePath/sourceType for a local source", async () => {
		const state = initState("cool-app", "cool-app", "name: cool-app\n", {
			sourceType: "local",
			sourcePath: "/Users/me/code/myrepo/Launchfile",
		});
		await saveState("cool-app", state);

		const loaded = await loadState("cool-app");
		expect(loaded).not.toBeNull();
		expect(loaded!.sourceType).toBe("local");
		expect(loaded!.sourcePath).toBe("/Users/me/code/myrepo/Launchfile");
	});

	it("records the catalog slug and sourceType for catalog sources", async () => {
		const state = initState("ghost", "ghost", "name: ghost\n", {
			sourceType: "catalog",
		});
		await saveState("ghost", state);

		const src = await loadDockerSource("ghost");
		expect(src).not.toBeNull();
		expect(src!.slug).toBe("ghost");
		expect(src!.sourceType).toBe("catalog");
		// No on-disk path for catalog sources — re-resolve from the slug.
		expect(src!.sourcePath).toBeUndefined();
	});

	it("records the URL for url sources", async () => {
		const state = initState("remote", "remote", "name: remote\n", {
			sourceType: "url",
			sourceUrl: "https://example.com/Launchfile",
		});
		await saveState("remote", state);

		const src = await loadDockerSource("remote");
		expect(src!.sourceType).toBe("url");
		expect(src!.sourceUrl).toBe("https://example.com/Launchfile");
	});

	it("loadDockerSource returns null when no state exists", async () => {
		expect(await loadDockerSource("nope")).toBeNull();
	});
});

describe("docker state — backward compatibility", () => {
	it("loads a legacy state file that lacks the new source fields", async () => {
		// Simulate a state.json written before source persistence landed.
		const legacy: DockerState = {
			version: 1,
			slug: "legacy",
			appName: "legacy",
			composeProject: "launchfile-legacy",
			launchfileHash: "deadbeef",
			createdAt: "2024-01-01T00:00:00.000Z",
			updatedAt: "2024-01-01T00:00:00.000Z",
			secrets: {},
			ports: { default: 3000 },
		};
		const dir = stateDir("legacy");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "state.json"), JSON.stringify(legacy, null, 2));

		const loaded = await loadState("legacy");
		expect(loaded).not.toBeNull();
		// New fields are absent but loading does not throw.
		expect(loaded!.sourceType).toBeUndefined();
		expect(loaded!.sourcePath).toBeUndefined();

		const src = await loadDockerSource("legacy");
		expect(src).not.toBeNull();
		expect(src!.slug).toBe("legacy");
		expect(src!.sourcePath).toBeUndefined();
	});
});
