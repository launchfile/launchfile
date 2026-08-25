import { describe, it, expect } from "vitest";
import { PostgresProvisioner, type ShellRunner } from "../resources/postgres.js";
import type { NormalizedRequirement } from "@launchfile/sdk";
import type { ProvisionOpts } from "../resources/types.js";
import type { ResourceState } from "../state.js";

const REQ = { type: "postgres" } as NormalizedRequirement;
const OPTS = { appName: "my-app" } as ProvisionOpts;

/**
 * Records every command issued. `okFor` decides the exit status of shellOk
 * calls; anything not matched succeeds, so each test states only the failure
 * it cares about.
 */
function recorder(okFor: (cmd: string) => boolean = () => true) {
	const commands: string[] = [];
	// Flattened to `cmd arg arg` so the assertions below stay readable; the
	// provisioner passes argv arrays.
	const flatten = (cmd: string, args: string[]) => [cmd, ...args].join(" ");
	const deps: ShellRunner = {
		shell: async (cmd: string, args: string[]) => {
			commands.push(flatten(cmd, args));
			return { exitCode: 0, stdout: "", stderr: "" };
		},
		shellOk: async (cmd: string, args: string[]) => {
			commands.push(flatten(cmd, args));
			return okFor(flatten(cmd, args));
		},
	};
	return { commands, deps };
}

describe("PostgresProvisioner readiness gate", () => {
	it("throws when pg_isready does not report ready within the timeout", async () => {
		const { deps } = recorder((cmd) => !cmd.startsWith("pg_isready --timeout"));
		const provisioner = new PostgresProvisioner(deps);

		await expect(provisioner.provision(REQ, OPTS)).rejects.toThrow(
			/did not accept connections within 10s/,
		);
	});

	it("issues no psql or createdb command when the server never becomes ready", async () => {
		const { commands, deps } = recorder(
			(cmd) => !cmd.startsWith("pg_isready --timeout"),
		);
		const provisioner = new PostgresProvisioner(deps);

		await expect(provisioner.provision(REQ, OPTS)).rejects.toThrow();

		// The point of failing fast: nothing downstream runs against a dead server.
		expect(commands.filter((c) => c.startsWith("psql"))).toEqual([]);
		expect(commands.filter((c) => c.startsWith("createdb"))).toEqual([]);
	});

	it("provisions the database when the server reports ready", async () => {
		const { commands, deps } = recorder();
		const provisioner = new PostgresProvisioner(deps);

		const { properties, state } = await provisioner.provision(REQ, OPTS);

		expect(commands).toContain("pg_isready --timeout=10");
		expect(properties.name).toBe("launchfile_my_app");
		expect(properties.user).toBe("launchfile_my_app");
		expect(properties.host).toBe("localhost");
		expect(properties.port).toBe(5432);
		expect(state.dbName).toBe("launchfile_my_app");
	});

	it("skips brew startup when postgres is already running", async () => {
		const { commands, deps } = recorder();
		const provisioner = new PostgresProvisioner(deps);

		await provisioner.provision(REQ, OPTS);

		expect(commands.filter((c) => c.startsWith("brew"))).toEqual([]);
	});

	it("starts postgres via brew when it is not already running", async () => {
		// `pg_isready -q` is the liveness probe; failing it forces the brew path,
		// while the later `--timeout` readiness check still succeeds.
		const { commands, deps } = recorder((cmd) => cmd !== "pg_isready -q");
		const provisioner = new PostgresProvisioner(deps);

		await provisioner.provision(REQ, OPTS);

		expect(commands).toContain("brew services start postgresql");
	});

	it("defaults to the real shell when no deps are injected", () => {
		// Guards the registry, which constructs the provisioner with no arguments.
		expect(() => new PostgresProvisioner()).not.toThrow();
		expect(new PostgresProvisioner().type).toBe("postgres");
	});
});

/**
 * Same trust boundary as the mysql provisioner: `.launchfile/state.json` is
 * JSON.parsed without validation, so the database name, user and password
 * provision() reuses from it are attacker-controlled.
 */
describe("PostgresProvisioner rejects unsafe values reused from state.json", () => {
	const STORED = {
		type: "postgres",
		name: "db",
		brewService: "postgresql",
		port: 5432,
		dbName: "launchfile_my_app",
		user: "launchfile_my_app",
		password: "s3cret-base64url_value",
	} as ResourceState;

	const cases = [
		{
			field: "dbName",
			value: "x; DROP DATABASE victim; --",
			message: /Invalid database name/,
		},
		{
			field: "user",
			value: "u; DROP DATABASE victim; --",
			message: /Invalid database user/,
		},
		{
			field: "password",
			value: "p'; ALTER ROLE postgres SUPERUSER; -- ",
			message: /Invalid database password/,
		},
	] as const;

	for (const { field, value, message } of cases) {
		it(`throws on a hostile ${field} and issues no psql command`, async () => {
			const { commands, deps } = recorder();
			const provisioner = new PostgresProvisioner(deps);

			await expect(
				provisioner.provision(REQ, OPTS, { ...STORED, [field]: value }),
			).rejects.toThrow(message);

			expect(commands.filter((c) => c.startsWith("psql"))).toEqual([]);
		});
	}
});
