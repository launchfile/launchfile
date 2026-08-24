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
import { beforeAll, describe, expect, it } from "vitest";
import { resourcePropertyKeys, translate } from "../translate.js";

const REGISTRY_PATH = join(
	import.meta.dirname,
	"../../../../spec/schema/resource-properties.json",
);

/** Keys this provider exposes beyond the standard vocabulary, per type. */
const EXTENSIONS: Record<string, string[]> = {};

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

describe("aws provider — resource property conformance", () => {
	let registry: Record<string, string[]>;
	const provider = resourcePropertyKeys();

	beforeAll(async () => {
		registry = await readRegistry();
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

describe("aws elasticache", () => {
	it("exposes the promised redis password", () => {
		// emitElastiCache()'s return is the property map a $redis.* expression
		// resolves against. The cluster carries no AUTH token, so the value is
		// empty — but the key is what the MUST is about.
		expect(resourcePropertyKeys().redis).toContain("password");
	});

	it("still emits a working cluster and url for a redis requirement", () => {
		const { hcl, conformance } = translate(
			readLaunch(`
version: launch/v1
name: my-app
runtime: node
commands:
  start: "node server.js"
requires:
  - type: redis
    set_env:
      REDIS_URL: $url
`),
		);

		expect(hcl).toContain('resource "aws_elasticache_cluster"');
		expect(
			conformance.mapped.some((m) => m.target === "aws_elasticache_cluster"),
		).toBe(true);
	});
});
