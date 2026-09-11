/**
 * PROVIDERS.md §10 rule 8 for postgres `config.extensions` (#317).
 *
 * The extensions reach postgres through an init script mounted into
 * /docker-entrypoint-initdb.d/, which postgres reads only while it initializes
 * an empty data directory. That directory lives on a named volume `down`
 * preserves unless `--destroy` is passed, so an extension declared after the
 * first run is never created — and, before this, was never reported.
 *
 * Detection only. The provider runs no SQL and asks the database nothing, so
 * these tests pin the split: a pure generator that names the volume KEY, and a
 * caller that resolves the project-scoped name Compose actually created.
 */

import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { launchToCompose } from "../compose-generator.js";
import {
	composeVolumeName,
	initOnlyExtensionsWarning,
	type VolumeProbe,
} from "../provider.js";

const app = (config: string, type = "postgres") => `
name: app
image: acme/app:1
provides:
  - { protocol: http, port: 3000, exposed: true }
requires:
  - type: ${type}${config}
`;

const withExtensions = app("\n    config:\n      extensions: [pgvector]");

interface ComposeDoc {
	services: Record<string, { volumes?: string[] }>;
	volumes?: Record<string, unknown>;
}

/** A probe that records its argv and replays a canned result. */
const probeReturning = (
	stdout: string,
	exitCode = 0,
): { probe: VolumeProbe; calls: string[][] } => {
	const calls: string[][] = [];
	const probe: VolumeProbe = async (cmd, args) => {
		calls.push([cmd, ...args]);
		return { exitCode, stdout, stderr: "" };
	};
	return { probe, calls };
};

describe("generator reports init-only extension delivery", () => {
	it("reports the postgres service, its component, and the SQL names", () => {
		const { initOnlyExtensions } = launchToCompose(readLaunch(withExtensions));
		expect(initOnlyExtensions).toEqual([
			{
				component: "default",
				service: "app-postgres",
				volume: "app-postgres-data",
				extensions: ["vector"],
			},
		]);
	});

	it("names the volume KEY the compose file declares, not a host name", () => {
		const result = launchToCompose(readLaunch(withExtensions));
		const doc = parse(result.yaml) as ComposeDoc;
		const key = result.initOnlyExtensions[0]?.volume;
		expect(doc.volumes).toHaveProperty(key as string);
		expect(doc.services["app-postgres"]?.volumes).toEqual([
			`${key}:/var/lib/postgresql/data`,
		]);
	});

	it("reports nothing when no extension is declared", () => {
		expect(launchToCompose(readLaunch(app(""))).initOnlyExtensions).toEqual([]);
	});

	it("reports nothing for a type that has no extension delivery", () => {
		const yaml = app("\n    config:\n      extensions: [pgvector]", "mysql");
		expect(launchToCompose(readLaunch(yaml)).initOnlyExtensions).toEqual([]);
	});

	it("reports nothing when every declared extension name is rejected", () => {
		const yaml = app('\n    config:\n      extensions: ["drop table"]');
		const { initOnlyExtensions, warnings } = launchToCompose(readLaunch(yaml));
		expect(initOnlyExtensions).toEqual([]);
		expect(warnings.join(" ")).toContain("is not a valid identifier");
	});
});

describe("composeVolumeName", () => {
	it("queries by the project and the compose volume key", async () => {
		const { probe, calls } = probeReturning("launchfile-app_app-postgres-data\n");
		await composeVolumeName("launchfile-app", "app-postgres-data", probe);
		expect(calls).toHaveLength(1);
		const argv = calls[0]!.join(" ");
		expect(argv).toContain("volume ls");
		expect(argv).toContain("label=com.docker.compose.project=launchfile-app");
		expect(argv).toContain("label=com.docker.compose.volume=app-postgres-data");
	});

	// The compose file's key is not a host volume name — Compose scopes what it
	// creates to the project. A lookup that returned the bare key would report
	// "absent" for a volume that exists, shipping this fix as silence.
	it("returns the project-scoped name Compose created, not the key", async () => {
		const { probe } = probeReturning("launchfile-app_app-postgres-data\n");
		const name = await composeVolumeName(
			"launchfile-app",
			"app-postgres-data",
			probe,
		);
		expect(name).toBe("launchfile-app_app-postgres-data");
		expect(name).not.toBe("app-postgres-data");
	});

	it("returns null when no volume matches", async () => {
		const { probe } = probeReturning("\n");
		expect(await composeVolumeName("p", "v", probe)).toBeNull();
	});

	it("returns null when docker fails", async () => {
		const { probe } = probeReturning("", 1);
		expect(await composeVolumeName("p", "v", probe)).toBeNull();
	});
});

describe("the warning", () => {
	const entry = {
		component: "default",
		service: "app-postgres",
		volume: "app-postgres-data",
		extensions: ["vector"],
	};
	const w = initOnlyExtensionsWarning(entry, "launchfile-app_app-postgres-data");

	it("names the service, the field, and the extensions", () => {
		expect(w).toContain("app-postgres");
		expect(w).toContain("config.extensions");
		expect(w).toContain("vector");
	});

	it("states the rule that makes the delivery a no-op", () => {
		expect(w).toContain("initializes an empty data directory");
		expect(w).toContain("launchfile-app_app-postgres-data");
	});

	it("gives the destructive remedy with its cost", () => {
		expect(w).toContain("launchfile down --destroy");
		expect(w).toContain("deletes app-postgres's data");
	});

	it("gives the non-destructive remedy", () => {
		expect(w).toContain("CREATE EXTENSION");
		expect(w).toContain("keep the data");
	});

	// Rule 8 asks a provider to report what IT did. This provider queries no
	// database, so it cannot know whether the extension is present — someone
	// may have created it by hand after the first run.
	it("says what the provider does, never what the database contains", () => {
		expect(w).toContain("this run creates none of them");
		expect(w).not.toMatch(/extension is (not installed|missing|absent)/);
	});
});
