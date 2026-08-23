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

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { launchToCompose, resourcePropertyKeys } from "../compose-generator.js";

const REGISTRY_PATH = join(
	import.meta.dirname,
	"../../../../spec/schema/resource-properties.json",
);

/**
 * Keys this provider exposes beyond the standard vocabulary, per type.
 *
 * `elasticsearch` `user`/`password`: the factory runs x-pack security on, so
 * credentials exist and are reported. Adopting them into the table is a
 * separate spec decision (issue #182, Part B).
 *
 * `minio` `region`: every S3 client SDK requires a region string, so the
 * factory hardcodes one. Also a Part B adoption candidate.
 *
 * `s3` `host`/`port`: this provider backs `s3` with a local MinIO, which is
 * addressable by host and port. Real S3 is a regional HTTPS endpoint with
 * neither, which is why the table keeps `s3` narrow.
 */
const EXTENSIONS: Record<string, string[]> = {
	elasticsearch: ["user", "password"],
	minio: ["region"],
	s3: ["host", "port"],
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

describe("docker provider — resource property conformance", () => {
	it("exposes at least the standard vocabulary for every listed type it supports", async () => {
		const registry = await readRegistry();
		const provider = resourcePropertyKeys();

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

	it("exposes no extension property outside the declared allowlist", async () => {
		const registry = await readRegistry();
		const provider = resourcePropertyKeys();

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

	it("declares no extension for a type it does not support", async () => {
		// Guards the allowlist itself: a stale entry would silently widen the
		// check above for a type that no longer exists here.
		const provider = resourcePropertyKeys();
		for (const type of Object.keys(EXTENSIONS)) {
			expect(Object.keys(provider)).toContain(type);
		}
	});

	it("skips the types it does not stand up", () => {
		const provider = resourcePropertyKeys();
		// Both are in the registry; neither has a factory here. addBackingService
		// warns and skips, so there is nothing to conform.
		expect(provider).not.toHaveProperty("sqlite");
		expect(provider).not.toHaveProperty("kafka");
	});
});

describe("docker clickhouse", () => {
	it("exposes the promised user and password", () => {
		const keys = resourcePropertyKeys();
		expect(keys.clickhouse).toContain("user");
		expect(keys.clickhouse).toContain("password");
	});

	it("resolves $user through set_env to the image's default user", () => {
		const launch = readLaunch(`
name: analytics
image: app:1
requires:
  - type: clickhouse
    set_env:
      CLICKHOUSE_USER: $user
      CLICKHOUSE_PASSWORD: $password
`);
		const result = launchToCompose(launch);

		expect(result.yaml).toContain("CLICKHOUSE_USER: default");
		// Empty password is the image's shipped default, reported honestly.
		expect(result.yaml).toContain('CLICKHOUSE_PASSWORD: ""');
	});
});

describe("docker redis", () => {
	it("exposes the promised password", () => {
		expect(resourcePropertyKeys().redis).toContain("password");
	});
});

describe("docker elasticsearch", () => {
	it("does not expose name — elasticsearch provisions no named database", () => {
		expect(resourcePropertyKeys().elasticsearch).not.toContain("name");
	});

	it("still exposes the credentials the factory generates", () => {
		const keys = resourcePropertyKeys().elasticsearch;
		expect(keys).toContain("user");
		expect(keys).toContain("password");
	});
});
