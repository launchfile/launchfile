/**
 * A SQL provisioner creates a role or user with a password, and the next
 * `provision()` only knows that password if it reached state.json. The
 * provisioner hands its record to `opts.persist` before that create, so a
 * throw anywhere later — in this provisioner or after it — cannot leave a
 * role whose password no state file holds.
 */

import type { NormalizedRequirement } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { MysqlProvisioner } from "../resources/mysql.js";
import { PostgresProvisioner } from "../resources/postgres.js";
import type {
	ProvisionOpts,
	ResourceProvisioner,
	ShellRunner,
} from "../resources/types.js";
import type { ResourceState } from "../state.js";

const OPTS = { appName: "my-app" } as ProvisionOpts;

/**
 * One ordered log of shell commands and persist calls, so a test can say
 * which came first. `throwOn` makes the first matching shell command throw,
 * standing in for any step after the role or user exists.
 */
function harness(throwOn?: (cmd: string) => boolean) {
	const log: string[] = [];
	const saved: ResourceState[] = [];
	const flatten = (cmd: string, args: string[]) => [cmd, ...args].join(" ");
	const deps: ShellRunner = {
		shell: async (cmd: string, args: string[]) => {
			const line = flatten(cmd, args);
			log.push(line);
			if (throwOn?.(line)) throw new Error(`boom: ${cmd}`);
			// psql's existence query prints nothing: no database exists yet.
			return { exitCode: 0, stdout: "", stderr: "" };
		},
		shellOk: async (cmd: string, args: string[]) => {
			log.push(flatten(cmd, args));
			return true;
		},
	};
	const persist = async (state: ResourceState) => {
		log.push(`persist ${state.password}`);
		saved.push(structuredClone(state));
	};
	return { log, saved, deps, persist };
}

const CASES: {
	type: string;
	make: (deps: ShellRunner) => ResourceProvisioner;
	/** The command that creates the credential-bearing object. */
	isCreate: (cmd: string) => boolean;
	/** A command that runs after the create. */
	isLater: (cmd: string) => boolean;
	/** Every command a first run issues for an unnamed entry. */
	unnamedSequence: (password: string) => string[];
}[] = [
	{
		type: "postgres",
		make: (deps) => new PostgresProvisioner(deps),
		isCreate: (cmd) => cmd.startsWith("psql") && cmd.includes("CREATE ROLE"),
		isLater: (cmd) => cmd.startsWith("createdb"),
		unnamedSequence: (password) => [
			"pg_isready -q",
			"pg_isready --timeout=10",
			`psql -h localhost -p 5432 postgres -c DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'launchfile_my_app') THEN CREATE ROLE launchfile_my_app WITH LOGIN PASSWORD '${password}' CREATEDB; END IF; END $$;`,
			"psql -h localhost -p 5432 postgres -tAc SELECT 1 FROM pg_database WHERE datname='launchfile_my_app'",
			"createdb -h localhost -p 5432 -O launchfile_my_app launchfile_my_app",
		],
	},
	{
		type: "mysql",
		make: (deps) => new MysqlProvisioner(deps),
		isCreate: (cmd) => cmd.startsWith("mysql") && cmd.includes("CREATE USER"),
		isLater: (cmd) => cmd.startsWith("mysql") && cmd.includes("GRANT"),
		unnamedSequence: (password) => [
			"mysqladmin ping -h localhost --silent",
			"mysql -h localhost -u root -e CREATE DATABASE IF NOT EXISTS `launchfile_my_app`;",
			`mysql -h localhost -u root -e CREATE USER IF NOT EXISTS 'launchfile_my_app'@'localhost' IDENTIFIED BY '${password}';`,
			"mysql -h localhost -u root -e GRANT ALL PRIVILEGES ON `launchfile_my_app`.* TO 'launchfile_my_app'@'localhost';",
		],
	},
];

for (const { type, make, isCreate, isLater, unnamedSequence } of CASES) {
	const req = { type } as NormalizedRequirement;

	describe(`${type} provisioner saves its record before creating the credential`, () => {
		it("hands persist the minted password before the create command runs", async () => {
			const { log, saved, deps, persist } = harness();

			const { state } = await make(deps).provision(req, { ...OPTS, persist });

			expect(saved).toHaveLength(1);
			const password = saved[0]?.password;
			expect(password).toBeTruthy();
			const persistAt = log.indexOf(`persist ${password}`);
			const createAt = log.findIndex(isCreate);
			expect(createAt).toBeGreaterThan(-1);
			expect(persistAt).toBeLessThan(createAt);
			expect(log[createAt]).toContain(password);
			// The returned record is the one persisted.
			expect(state).toEqual(saved[0]);
		});

		it("reuses the persisted password after a later step throws", async () => {
			const first = harness(isLater);

			await expect(
				make(first.deps).provision(req, { ...OPTS, persist: first.persist }),
			).rejects.toThrow(/boom/);

			// The create ran with the minted password, and that record was saved.
			const record = first.saved[0];
			expect(record?.password).toBeTruthy();
			const firstCreate = first.log.find(isCreate);
			expect(firstCreate).toContain(record?.password);

			const second = harness();
			const { properties } = await make(second.deps).provision(
				req,
				{ ...OPTS, persist: second.persist },
				record,
			);

			expect(second.log.find(isCreate)).toBe(firstCreate);
			expect(properties.password).toBe(record?.password);
			expect(second.saved[0]).toEqual(record);
		});

		it("issues the same command sequence for an unnamed entry with or without persist", async () => {
			const withPersist = harness();
			const { state } = await make(withPersist.deps).provision(req, {
				...OPTS,
				persist: withPersist.persist,
			});
			const without = harness();
			await make(without.deps).provision(req, OPTS, state);

			const commands = withPersist.log.filter(
				(line) => !line.startsWith("persist "),
			);
			expect(commands).toEqual(unnamedSequence(state.password ?? ""));
			expect(without.log).toEqual(commands);
		});

		it("persists nothing when a stored value fails the safety checks", async () => {
			const { saved, deps, persist } = harness();
			const hostile = {
				type,
				name: type,
				port: 1,
				dbName: "x; DROP DATABASE victim; --",
				user: "launchfile_my_app",
				password: "s3cret-base64url_value",
			} as ResourceState;

			await expect(
				make(deps).provision(req, { ...OPTS, persist }, hostile),
			).rejects.toThrow(/Invalid database name/);
			expect(saved).toEqual([]);
		});
	});
}
