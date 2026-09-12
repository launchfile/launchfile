import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaunch } from "@launchfile/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { planBootstraps } from "../bootstrap.js";
import { launchToCompose } from "../compose-generator.js";
import { clearRegisteredSecrets, REDACTED, redactSecrets } from "../redact.js";
import { planReleases } from "../release.js";
import {
	declaredSecrets,
	migrateResourcePasswords,
	RESOURCE_PASSWORD_KEYS,
} from "../secrets-namespace.js";
import { initState, loadState, saveState } from "../state.js";

function envOf(yaml: string, service: string): Record<string, string> {
	const compose = parse(yaml) as {
		services: Record<string, { environment?: Record<string, string> }>;
	};
	return compose.services[service]?.environment ?? {};
}

describe("backing-service passwords live outside $secrets (#237)", () => {
	it("keeps a declared secret named after a resource type distinct from that resource's password", () => {
		// The collision: `postgres` is both a declared secret name and the key
		// the provider mints its database password under.
		const launch = readLaunch(`
name: acme
secrets:
  postgres:
    generator: secret
components:
  app:
    image: acme/app:1
    requires:
      - type: postgres
        set_env:
          DB_PASSWORD: $password
    env:
      ADMIN_TOKEN: $secrets.postgres
`);
		const result = launchToCompose(launch);

		const declared = result.secrets.postgres!;
		const password = result.resourcePasswords.postgres!;
		expect(declared).toBeTruthy();
		expect(password).toBeTruthy();
		expect(declared).not.toBe(password);

		const env = envOf(result.yaml, "acme-app");
		expect(env.ADMIN_TOKEN).toBe(declared);
		expect(env.DB_PASSWORD).toBe(password);
	});

	it("resolves an undeclared $secrets.postgres to nothing, not to the database password", () => {
		const launch = readLaunch(`
name: acme
components:
  app:
    image: acme/app:1
    requires:
      - postgres
    env:
      LEAK: $secrets.postgres
`);
		const result = launchToCompose(launch);

		const password = result.resourcePasswords.postgres!;
		expect(password).toBeTruthy();
		expect(result.secrets.postgres).toBeUndefined();
		expect(envOf(result.yaml, "acme-app").LEAK).toBe("");
	});

	it("migrates a pre-split state file by moving the password, never re-minting it", () => {
		// State written before the split: the database password sits in
		// `secrets`, keyed by resource type.
		const existing = "pre-split-postgres-password";
		const secrets: Record<string, string> = { postgres: existing };
		const resourcePasswords: Record<string, string> = {};

		const launch = readLaunch(`
name: acme
components:
  app:
    image: acme/app:1
    requires:
      - postgres
`);
		const result = launchToCompose(launch, { secrets, resourcePasswords });

		// Moved, not re-minted — a fresh password would lock the app out of the
		// data volume the old one initialized.
		expect(result.resourcePasswords.postgres).toBe(existing);
		expect(result.secrets.postgres).toBeUndefined();
		expect(envOf(result.yaml, "acme-postgres").POSTGRES_PASSWORD).toBe(
			existing,
		);
		expect(result.warnings).toHaveLength(0);
	});

	it("keeps a migrated password in both maps and warns when the Launchfile declares that name", () => {
		const shared = "shared-pre-split-value";
		const launch = readLaunch(`
name: acme
secrets:
  postgres:
    generator: secret
components:
  app:
    image: acme/app:1
    requires:
      - postgres
    env:
      ADMIN_TOKEN: $secrets.postgres
`);
		const result = launchToCompose(launch, { secrets: { postgres: shared } });

		expect(result.resourcePasswords.postgres).toBe(shared);
		expect(result.secrets.postgres).toBe(shared);
		expect(result.warnings.join("\n")).toContain('acme: secret "postgres"');
		// Neither side is re-minted: the app keeps the token it stored, the
		// database keeps the password its volume was initialized with.
		expect(envOf(result.yaml, "acme-app").ADMIN_TOKEN).toBe(shared);
		expect(envOf(result.yaml, "acme-postgres").POSTGRES_PASSWORD).toBe(shared);
	});

	it("mints under exactly the keys the reserved vocabulary lists", () => {
		const launch = readLaunch(`
name: acme
components:
  app:
    image: acme/app:1
    requires:
      - postgres
      - mysql
      - mariadb
      - mongodb
      - elasticsearch
      - minio
      - s3
      - rabbitmq
      - redis
      - clickhouse
      - memcache
`);
		const result = launchToCompose(launch);
		expect(Object.keys(result.resourcePasswords).sort()).toEqual(
			[...RESOURCE_PASSWORD_KEYS].sort(),
		);
	});
});

describe("release and bootstrap contexts (#237)", () => {
	const launch = readLaunch(`
name: acme
secrets:
  admin_token:
    generator: secret
components:
  app:
    image: acme/app:1
    commands:
      release:
        command: migrate --token $secrets.admin_token --db $secrets.postgres
      bootstrap:
        command: seed --token $secrets.admin_token --db $secrets.postgres
`);
	const stored = {
		admin_token: "declared-admin-token",
		postgres: "leftover-db-password",
	};

	it("resolves only declared names in a release command", () => {
		const plan = planReleases(launch, {
			services: { app: "acme" },
			hostPorts: {},
			secrets: stored,
		});
		expect(plan[0]!.command).toBe("migrate --token declared-admin-token --db ");
	});

	it("resolves only declared names in a bootstrap command", () => {
		const plan = planBootstraps(launch, { hostPorts: {}, secrets: stored });
		expect(plan[0]!.command).toBe("seed --token declared-admin-token --db ");
	});

	it("registers backing-service passwords for redaction before a release runs", () => {
		clearRegisteredSecrets();
		const password = "release-time-db-password";
		planReleases(launch, {
			services: { app: "acme" },
			hostPorts: {},
			secrets: { admin_token: "declared-admin-token" },
			resourcePasswords: { postgres: password },
		});
		expect(redactSecrets(`psql ${password}`)).toBe(`psql ${REDACTED}`);
	});
});

describe("migrateResourcePasswords", () => {
	it("leaves a state file that has already been split alone", () => {
		const secrets = { admin_token: "declared" };
		const resourcePasswords = { postgres: "db-password" };
		const warnings = migrateResourcePasswords(
			secrets,
			resourcePasswords,
			new Set(["admin_token"]),
			"acme",
		);
		expect(warnings).toEqual([]);
		expect(secrets).toEqual({ admin_token: "declared" });
		expect(resourcePasswords).toEqual({ postgres: "db-password" });
	});

	it("does not overwrite a password already recorded in the new map", () => {
		const secrets = { postgres: "stale-copy" };
		const resourcePasswords = { postgres: "authoritative" };
		migrateResourcePasswords(secrets, resourcePasswords, new Set(), "acme");
		expect(resourcePasswords.postgres).toBe("authoritative");
		expect(secrets.postgres).toBeUndefined();
	});
});

describe("declaredSecrets", () => {
	it("keeps only names the Launchfile declares", () => {
		expect(declaredSecrets({ a: {}, missing: {} }, { a: "1", b: "2" })).toEqual(
			{ a: "1" },
		);
	});

	it("returns an empty view when nothing is declared", () => {
		expect(declaredSecrets(undefined, { a: "1" })).toEqual({});
	});
});

describe("persisted backing-service passwords stay redactable", () => {
	// state.ts keys everything off homedir() → ~/.launchfile/docker/<slug>.
	// node:os.homedir() honors $HOME on POSIX, so redirect it to a temp dir to
	// keep the real ~/.launchfile untouched.
	let prevHome: string | undefined;
	let tmpHome: string;

	beforeEach(() => {
		prevHome = process.env.HOME;
		tmpHome = mkdtempSync(join(tmpdir(), "lf-docker-respw-"));
		process.env.HOME = tmpHome;
	});

	afterEach(() => {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("survives the persisted round trip when an old-shape state file is upgraded", async () => {
		const existing = "pre-split-persisted-password";
		const launch = readLaunch(`
name: acme
components:
  app:
    image: acme/app:1
    requires:
      - postgres
`);

		// Old shape on disk: the database password inside `secrets`.
		const before = initState("acme", "acme", "name: acme\n");
		before.secrets = { postgres: existing };
		await saveState("acme", before);

		const loaded = (await loadState("acme"))!;
		const result = launchToCompose(launch, {
			secrets: loaded.secrets,
			resourcePasswords: loaded.resourcePasswords,
		});
		loaded.secrets = result.secrets;
		loaded.resourcePasswords = result.resourcePasswords;
		await saveState("acme", loaded);

		const after = (await loadState("acme"))!;
		expect(after.resourcePasswords).toEqual({ postgres: existing });
		expect(after.secrets).toEqual({});
	});

	it("registers resourcePasswords on load", async () => {
		const password = "persisted-db-password-value";
		const state = initState("acme", "acme", "name: acme\n");
		state.resourcePasswords = { postgres: password };
		await saveState("acme", state);

		clearRegisteredSecrets();
		const loaded = await loadState("acme");
		expect(loaded!.resourcePasswords).toEqual({ postgres: password });
		expect(redactSecrets(`psql ${password}`)).toBe(`psql ${REDACTED}`);
	});
});
