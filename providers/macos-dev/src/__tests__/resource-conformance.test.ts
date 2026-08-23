/**
 * Conformance of this provider's resource properties against the standard
 * vocabulary (SPEC.md § Resource Property Vocabulary, D-46).
 *
 * Both directions are checked:
 *
 * - MUST — for every listed type the provider supports, it exposes at least the
 *   registry's keys. A missing key is a conformance bug (the D-30 / #173 shape).
 * - MAY — every key beyond the registry is named in EXTENSIONS below. The
 *   vocabulary for a known type is open, so an extra key is legal; what is not
 *   legal is an extra key nobody decided on. Without this direction only half
 *   the surface is guarded, and the extension side drifts silently.
 *
 * The registry is read from `spec/schema/resource-properties.json` so the check
 * tracks the ratified table rather than a copy of it.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedRequirement } from "@launchfile/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
	getProvisioner,
	type ShellRunner,
	supportedResourceTypes,
} from "../resources/index.js";

const REGISTRY_PATH = join(
	import.meta.dirname,
	"../../../../spec/schema/resource-properties.json",
);

/** Keys this provider exposes beyond the standard vocabulary, per type. */
const EXTENSIONS: Record<string, string[]> = {};

/** A shell that runs nothing and reports success, so no brew or server is touched. */
const NO_OP_SHELL: Partial<ShellRunner> = {
	shell: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	shellOk: async () => true,
};

async function readRegistry(): Promise<Record<string, string[]>> {
	const raw = await readFile(REGISTRY_PATH, "utf8");
	const parsed = JSON.parse(raw) as {
		types: Record<string, Record<string, string>>;
	};
	const out: Record<string, string[]> = {};
	for (const [type, props] of Object.entries(parsed.types)) {
		out[type] = Object.keys(props);
	}
	return out;
}

/** Provision every supported type against the no-op shell and collect its keys. */
async function providerKeys(
	projectDir: string,
): Promise<Record<string, string[]>> {
	const out: Record<string, string[]> = {};
	for (const type of supportedResourceTypes()) {
		const provisioner = getProvisioner(type, NO_OP_SHELL);
		if (!provisioner) throw new Error(`no provisioner for ${type}`);
		const { properties } = await provisioner.provision(
			{ type } as NormalizedRequirement,
			{ appName: "my-app", projectDir },
		);
		out[type] = Object.keys(properties);
	}
	return out;
}

describe("macos-dev provider — resource property conformance", () => {
	let registry: Record<string, string[]>;
	let provider: Record<string, string[]>;

	beforeAll(async () => {
		registry = await readRegistry();
		provider = await providerKeys(await mkdtemp(join(tmpdir(), "lf-conf-")));
	});

	it("exposes at least the standard vocabulary for every listed type it supports", () => {
		const missing: string[] = [];
		for (const [type, keys] of Object.entries(provider)) {
			const promised = registry[type];
			// The trigger is "supports a listed type". A type this provider
			// stands up that the registry does not list (mariadb) has no
			// vocabulary and stays fully open (L-4).
			if (!promised) continue;
			for (const key of promised) {
				if (!keys.includes(key)) missing.push(`${type}.${key}`);
			}
		}

		expect(missing).toEqual([]);
	});

	it("exposes no extension property outside the declared allowlist", () => {
		const undeclared: string[] = [];
		for (const [type, keys] of Object.entries(provider)) {
			const promised = registry[type];
			if (!promised) continue;
			const allowed = new Set([...promised, ...(EXTENSIONS[type] ?? [])]);
			for (const key of keys) {
				if (!allowed.has(key)) undeclared.push(`${type}.${key}`);
			}
		}

		expect(undeclared).toEqual([]);
	});

	it("covers mariadb without grading it — the registry does not list the type", () => {
		expect(provider).toHaveProperty("mariadb");
		expect(registry).not.toHaveProperty("mariadb");
	});
});

describe("macos-dev sqlite", () => {
	let properties: Record<string, string | number | undefined>;

	beforeAll(async () => {
		const projectDir = await mkdtemp(join(tmpdir(), "lf-sqlite-"));
		const provisioner = getProvisioner("sqlite");
		if (!provisioner) throw new Error("no sqlite provisioner");
		({ properties } = await provisioner.provision(
			{ type: "sqlite" } as NormalizedRequirement,
			{ appName: "my-app", projectDir },
		));
	});

	it("exposes neither host nor port — a file has neither", () => {
		// `port: 0` was a value an app could act on (connect(host, 0)). Absent,
		// $sqlite.port resolves to "" through the unknown-property rule instead.
		expect(properties).not.toHaveProperty("host");
		expect(properties).not.toHaveProperty("port");
	});

	it("exposes the url and path the table promises", () => {
		expect(properties.url).toMatch(/^sqlite:\/\//);
		expect(String(properties.path)).toContain("my_app.db");
	});
});

describe("macos-dev network resources still carry host and port", () => {
	// Regression guard for loosening ResourceProperties: making host/port
	// optional must not let a networked type quietly drop them.
	for (const type of ["postgres", "mysql", "redis"]) {
		it(`${type} exposes host and port`, async () => {
			const provisioner = getProvisioner(type, NO_OP_SHELL);
			if (!provisioner) throw new Error(`no ${type} provisioner`);
			const { properties } = await provisioner.provision(
				{ type } as NormalizedRequirement,
				{ appName: "my-app", projectDir: tmpdir() },
			);

			expect(properties.host).toBe("localhost");
			expect(typeof properties.port).toBe("number");
			expect(properties.port).toBeGreaterThan(0);
		});
	}
});
