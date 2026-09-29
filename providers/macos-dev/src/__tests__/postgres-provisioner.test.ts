import { afterEach, describe, it, expect, vi } from "vitest";
import { PostgresProvisioner, type ShellRunner } from "../resources/postgres.js";
import type { NormalizedRequirement } from "@launchfile/sdk";
import type { ProvisionOpts } from "../resources/types.js";
import type { ShellResult } from "../shell.js";
import type { ResourceState } from "../state.js";

const REQ = { type: "postgres" } as NormalizedRequirement;
const OPTS = { appName: "my-app" } as ProvisionOpts;

/**
 * Records every command issued. `okFor` decides the exit status of shellOk
 * calls; `stdoutFor` decides what a shell call prints (every shell call exits
 * 0, as psql does for a zero-row SELECT) unless `resultFor` gives a command
 * its own exit code and stderr. A non-zero result rejects the way the real
 * `shell` does unless the call passed `allowFailure`, so a test sees exactly
 * the failures the provisioner tolerates. Anything not matched succeeds with
 * empty output, so each test states only the outcome it cares about.
 */
function recorder(
	okFor: (cmd: string) => boolean = () => true,
	stdoutFor: (cmd: string) => string = () => "",
	resultFor: (cmd: string) => Partial<ShellResult> | undefined = () => undefined,
) {
	const commands: string[] = [];
	// Flattened to `cmd arg arg` so the assertions below stay readable; the
	// provisioner passes argv arrays.
	const flatten = (cmd: string, args: string[]) => [cmd, ...args].join(" ");
	const deps: ShellRunner = {
		shell: async (cmd: string, args: string[], opts?: { allowFailure?: boolean }) => {
			const display = flatten(cmd, args);
			commands.push(display);
			const result: ShellResult = {
				exitCode: 0,
				stdout: stdoutFor(display),
				stderr: "",
				...resultFor(display),
			};
			if (result.exitCode !== 0 && !opts?.allowFailure) {
				throw Object.assign(new Error(`Command failed: ${display}\n${result.stderr}`), { result });
			}
			return result;
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
 * psql exits 0 whenever a query ran, rows or not, so the existence check must
 * read the row it prints. An exit-code test would report every database as
 * present and never create one.
 */
describe("PostgresProvisioner database existence check reads psql's output", () => {
	const EXISTS_QUERY =
		"psql -h localhost -p 5432 postgres -tAc SELECT 1 FROM pg_database WHERE datname='launchfile_my_app'";

	it("creates the app database when the query exits 0 with no row", async () => {
		const { commands, deps } = recorder();
		const provisioner = new PostgresProvisioner(deps);

		await provisioner.provision(REQ, OPTS);

		expect(commands).toContain(EXISTS_QUERY);
		expect(commands.filter((c) => c.startsWith("createdb"))).toEqual([
			"createdb -h localhost -p 5432 -O launchfile_my_app launchfile_my_app",
		]);
	});

	it("skips createdb when the query prints a row", async () => {
		const { commands, deps } = recorder(undefined, (cmd) =>
			cmd === EXISTS_QUERY ? "1\n" : "",
		);
		const provisioner = new PostgresProvisioner(deps);

		await provisioner.provision(REQ, OPTS);

		expect(commands.filter((c) => c.startsWith("createdb"))).toEqual([]);
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

describe("PostgresProvisioner named `database` uses (SPEC.md § Resource uses)", () => {
	// The app's own database prints a row; a named one prints nothing (exit 0
	// either way, as psql does).
	const onlyAppDatabaseExists = (cmd: string) =>
		cmd.includes("datname='launchfile_my_app'") ? "1\n" : "";

	it("creates each named database as <instance>_<name> through the same createdb path, owned by the app user, and records them in state", async () => {
		const { commands, deps } = recorder(undefined, onlyAppDatabaseExists);
		const provisioner = new PostgresProvisioner(deps);

		const { state } = await provisioner.provision(REQ, { ...OPTS, databases: ["audit-log", "reports"] });

		// The app's own database already exists here; only the named ones are created.
		expect(commands.filter((c) => c.startsWith("createdb"))).toEqual([
			"createdb -h localhost -p 5432 -O launchfile_my_app launchfile_my_app_audit_log",
			"createdb -h localhost -p 5432 -O launchfile_my_app launchfile_my_app_reports",
		]);
		expect(state.databases).toEqual(["launchfile_my_app_audit_log", "launchfile_my_app_reports"]);
	});

	it("creates a named database when its existence query exits 0 with no row", async () => {
		// The zero-row case is the one an exit-code test gets wrong.
		const { commands, deps } = recorder();
		const provisioner = new PostgresProvisioner(deps);

		await provisioner.provision(REQ, { ...OPTS, databases: ["reports"] });

		expect(commands).toContain(
			"psql -h localhost -p 5432 postgres -tAc SELECT 1 FROM pg_database WHERE datname='launchfile_my_app_reports'",
		);
		expect(commands.filter((c) => c.startsWith("createdb"))).toContain(
			"createdb -h localhost -p 5432 -O launchfile_my_app launchfile_my_app_reports",
		);
	});

	it("skips a named database whose existence query prints a row, and records no list when none is named", async () => {
		const { commands, deps } = recorder(undefined, () => "1\n");
		const provisioner = new PostgresProvisioner(deps);

		await provisioner.provision(REQ, { ...OPTS, databases: ["reports"] });
		expect(commands.filter((c) => c.startsWith("createdb"))).toEqual([]);
		expect(commands).toContain("psql -h localhost -p 5432 postgres -tAc SELECT 1 FROM pg_database WHERE datname='launchfile_my_app_reports'");

		const plain = await provisioner.provision(REQ, OPTS);
		expect(plain.state).not.toHaveProperty("databases");
	});

	it("drops the named databases it created on destroy, skipping an unsafe stored name", async () => {
		const { commands, deps } = recorder();
		const provisioner = new PostgresProvisioner(deps);
		const stored = {
			type: "postgres",
			name: "postgres",
			port: 5432,
			dbName: "launchfile_my_app",
			user: "launchfile_my_app",
			databases: ["launchfile_my_app_reports", "x; DROP DATABASE victim"],
		} as ResourceState;

		await provisioner.destroy(stored, { projectDir: "/tmp/lf-pg-test" });

		expect(commands.filter((c) => c.startsWith("dropdb"))).toEqual([
			"dropdb -h localhost --if-exists launchfile_my_app",
			"dropdb -h localhost --if-exists launchfile_my_app_reports",
		]);
	});
});

/**
 * The third outcome of the existence check: psql could not answer. Reading a
 * non-zero exit as "absent" would fall through to a tolerated createdb and
 * hand the app a URL to a database nobody created (#521 item 2).
 */
describe("PostgresProvisioner fails `up` when the existence query cannot be answered", () => {
	const EXISTS_QUERY =
		"psql -h localhost -p 5432 postgres -tAc SELECT 1 FROM pg_database WHERE datname='launchfile_my_app'";
	const psqlDown = (cmd: string) =>
		cmd === EXISTS_QUERY
			? { exitCode: 2, stderr: 'psql: error: connection to server at "localhost" (::1), port 5432 failed: FATAL:  password authentication failed for user "me"\n' }
			: undefined;

	it("throws with psql's stderr in the message on a non-zero exit", async () => {
		const { deps } = recorder(undefined, undefined, psqlDown);
		const provisioner = new PostgresProvisioner(deps);

		await expect(provisioner.provision(REQ, OPTS)).rejects.toThrow(
			/Could not check whether database "launchfile_my_app" exists: psql exited 2: psql: error: .*password authentication failed/,
		);
	});

	it("issues no createdb after the query fails", async () => {
		const { commands, deps } = recorder(undefined, undefined, psqlDown);
		const provisioner = new PostgresProvisioner(deps);

		await expect(provisioner.provision(REQ, OPTS)).rejects.toThrow();

		expect(commands.filter((c) => c.startsWith("createdb"))).toEqual([]);
	});

	it("fails the same way when a named database's query cannot be answered", async () => {
		const NAMED_QUERY =
			"psql -h localhost -p 5432 postgres -tAc SELECT 1 FROM pg_database WHERE datname='launchfile_my_app_reports'";
		const { commands, deps } = recorder(undefined, undefined, (cmd) =>
			cmd === NAMED_QUERY ? { exitCode: 1, stderr: "psql: error: server closed the connection unexpectedly\n" } : undefined,
		);
		const provisioner = new PostgresProvisioner(deps);

		await expect(provisioner.provision(REQ, { ...OPTS, databases: ["reports"] })).rejects.toThrow(
			/"launchfile_my_app_reports" exists: psql exited 1: psql: error: server closed the connection/,
		);
		expect(commands.filter((c) => c.includes("launchfile_my_app_reports"))).toEqual([NAMED_QUERY]);
	});
});

/**
 * D-65 rule 3: a provider covers every declared use or refuses, naming the
 * entry, the token and the name. A createdb backing a named `database` use is
 * therefore not tolerated the way the app's own createdb, role creation and
 * extension creation still are — those declare no use, so rule 3 does not
 * reach them.
 */
describe("PostgresProvisioner refuses a named `database` use whose createdb fails", () => {
	const NAMED_CREATEDB = "createdb -h localhost -p 5432 -O launchfile_my_app launchfile_my_app_reports";
	const createdbFails = (cmd: string) =>
		cmd === NAMED_CREATEDB
			? { exitCode: 1, stderr: "createdb: error: database creation failed: ERROR:  permission denied to create database\n" }
			: undefined;

	it("throws naming the entry, the token and the name, with createdb's stderr", async () => {
		const { deps } = recorder(undefined, undefined, createdbFails);
		const provisioner = new PostgresProvisioner(deps);

		await expect(
			provisioner.provision({ type: "postgres", name: "main" } as NormalizedRequirement, { ...OPTS, databases: ["reports"] }),
		).rejects.toThrow(
			/Refused: main: database: reports — could not create database "launchfile_my_app_reports" \(Command failed: createdb [\s\S]*permission denied to create database/,
		);
	});

	it("names the entry by its type when it has no name", async () => {
		const { deps } = recorder(undefined, undefined, createdbFails);
		const provisioner = new PostgresProvisioner(deps);

		await expect(provisioner.provision(REQ, { ...OPTS, databases: ["reports"] })).rejects.toThrow(
			/^Refused: postgres: database: reports/,
		);
	});

	it("still tolerates a failing createdb for the app's own database", async () => {
		const { commands, deps } = recorder(undefined, undefined, (cmd) =>
			cmd === "createdb -h localhost -p 5432 -O launchfile_my_app launchfile_my_app"
				? { exitCode: 1, stderr: "createdb: error: permission denied\n" }
				: undefined,
		);
		const provisioner = new PostgresProvisioner(deps);

		const { state } = await provisioner.provision(REQ, { ...OPTS, databases: ["reports"] });

		expect(commands.filter((c) => c.startsWith("createdb"))).toEqual([
			"createdb -h localhost -p 5432 -O launchfile_my_app launchfile_my_app",
			NAMED_CREATEDB,
		]);
		expect(state.databases).toEqual(["launchfile_my_app_reports"]);
	});
});

/**
 * A database named on an earlier run and absent from this one is never
 * dropped by `up`: a one-line `uses:` edit must not destroy data. It stays in
 * `state.databases`, said out loud, so `destroy` still removes it (#521 item 1).
 */
describe("PostgresProvisioner keeps a database that vanished from the named uses", () => {
	const STORED = {
		type: "postgres",
		name: "postgres",
		brewService: "postgresql",
		port: 5432,
		dbName: "launchfile_my_app",
		user: "launchfile_my_app",
		password: "s3cret-base64url_value",
		databases: ["launchfile_my_app_audit_log", "launchfile_my_app_reports"],
	} as ResourceState;

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("records the vanished database after the current ones and issues no dropdb", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { commands, deps } = recorder(undefined, () => "1\n");
		const provisioner = new PostgresProvisioner(deps);

		const { state } = await provisioner.provision(REQ, { ...OPTS, databases: ["reports"] }, STORED);

		expect(state.databases).toEqual(["launchfile_my_app_reports", "launchfile_my_app_audit_log"]);
		expect(commands.filter((c) => c.startsWith("dropdb"))).toEqual([]);
		// The vanished one is neither checked nor created — it is only remembered.
		expect(commands.filter((c) => c.includes("launchfile_my_app_audit_log"))).toEqual([]);
	});

	it("warns naming the vanished database and the entry", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { deps } = recorder(undefined, () => "1\n");
		const provisioner = new PostgresProvisioner(deps);

		await provisioner.provision(
			{ type: "postgres", name: "main" } as NormalizedRequirement,
			{ ...OPTS, databases: ["reports"] },
			STORED,
		);

		expect(warn.mock.calls.map(([line]) => line)).toEqual([
			'  ! postgres: database "launchfile_my_app_audit_log" is no longer a named use of main — kept; `destroy` drops it',
		]);
	});

	it("keeps every stored database when the entry names none any more", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { deps } = recorder(undefined, () => "1\n");
		const provisioner = new PostgresProvisioner(deps);

		const { state } = await provisioner.provision(REQ, OPTS, STORED);

		expect(state.databases).toEqual(["launchfile_my_app_audit_log", "launchfile_my_app_reports"]);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("keeps an unsafe stored name for destroy to judge, without echoing it", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { commands, deps } = recorder(undefined, () => "1\n");
		const provisioner = new PostgresProvisioner(deps);
		const hostile = "x; DROP DATABASE victim";

		const { state } = await provisioner.provision(REQ, OPTS, { ...STORED, databases: [hostile] });

		expect(state.databases).toEqual([hostile]);
		expect(commands.some((c) => c.includes("victim"))).toBe(false);
		expect(warn.mock.calls.map(([line]) => line)).toEqual([
			"  ! postgres: database (unsafe name in state.json) is no longer a named use of postgres — kept; `destroy` drops it",
		]);
	});

	it("warns nothing and records no list when nothing vanished", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { deps } = recorder(undefined, () => "1\n");
		const provisioner = new PostgresProvisioner(deps);

		const { state } = await provisioner.provision(REQ, OPTS, { ...STORED, databases: undefined });

		expect(state).not.toHaveProperty("databases");
		expect(warn).not.toHaveBeenCalled();
	});
});

/**
 * P-13: an entry with no named `database` use produces byte-identical output
 * — the same commands in the same order and the same state shape — with and
 * without this file's named-use handling in the path.
 */
describe("PostgresProvisioner unnamed entry is unchanged (P-13)", () => {
	it("issues exactly the instance sequence and records no `databases` key", async () => {
		const { commands, deps } = recorder();
		const provisioner = new PostgresProvisioner(deps);

		const { properties, state } = await provisioner.provision(REQ, OPTS, {
			type: "postgres",
			name: "postgres",
			brewService: "postgresql",
			port: 5432,
			dbName: "launchfile_my_app",
			user: "launchfile_my_app",
			password: "s3cret-base64url_value",
		});

		expect(commands).toEqual([
			"pg_isready -q",
			"pg_isready --timeout=10",
			"psql -h localhost -p 5432 postgres -c DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'launchfile_my_app') THEN CREATE ROLE launchfile_my_app WITH LOGIN PASSWORD 's3cret-base64url_value' CREATEDB; END IF; END $$;",
			"psql -h localhost -p 5432 postgres -tAc SELECT 1 FROM pg_database WHERE datname='launchfile_my_app'",
			"createdb -h localhost -p 5432 -O launchfile_my_app launchfile_my_app",
		]);
		expect(properties).toEqual({
			url: "postgresql://launchfile_my_app:s3cret-base64url_value@localhost:5432/launchfile_my_app",
			host: "localhost",
			port: 5432,
			user: "launchfile_my_app",
			password: "s3cret-base64url_value",
			name: "launchfile_my_app",
		});
		expect(state).toEqual({
			type: "postgres",
			name: "postgres",
			brewService: "postgresql",
			port: 5432,
			dbName: "launchfile_my_app",
			user: "launchfile_my_app",
			password: "s3cret-base64url_value",
		});
	});
});
