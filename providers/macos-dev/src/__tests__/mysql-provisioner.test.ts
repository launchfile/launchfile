import type { NormalizedRequirement } from "@launchfile/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MysqlProvisioner } from "../resources/mysql.js";
import type { DestroyOpts, ProvisionOpts } from "../resources/types.js";
import type { ShellResult } from "../shell.js";
import type { ResourceState } from "../state.js";

const REQ = { type: "mysql" } as NormalizedRequirement;
const OPTS = { appName: "my-app" } as ProvisionOpts;
const DESTROY_OPTS: DestroyOpts = { projectDir: "/tmp/lf-mysql-test" };

/**
 * Records every command issued, flattened to `cmd arg arg` so the assertions
 * stay readable; the provisioner passes argv arrays. `resultFor` gives a
 * command its own exit code and stderr; a non-zero result rejects the way the
 * real `shell` does unless the call passed `allowFailure`, so a test sees
 * exactly the failures the provisioner tolerates.
 */
function recorder(
	resultFor: (cmd: string) => Partial<ShellResult> | undefined = () => undefined,
) {
	const commands: string[] = [];
	const flatten = (cmd: string, args: string[]) => [cmd, ...args].join(" ");
	const shell = async (cmd: string, args: string[], opts?: { allowFailure?: boolean }) => {
		const display = flatten(cmd, args);
		commands.push(display);
		const result: ShellResult = { exitCode: 0, stdout: "", stderr: "", ...resultFor(display) };
		if (result.exitCode !== 0 && !opts?.allowFailure) {
			throw Object.assign(new Error(`Command failed: ${display}\n${result.stderr}`), { result });
		}
		return result;
	};
	const shellOk = async (cmd: string, args: string[]) => {
		commands.push(flatten(cmd, args));
		return true;
	};
	return { commands, deps: { shell, shellOk } };
}

/** A state file from a previous run — the values provision() reuses. */
function state(overrides: Partial<ResourceState> = {}): ResourceState {
	return {
		type: "mysql",
		name: "db",
		brewService: "mysql",
		port: 3306,
		dbName: "launchfile_my_app",
		user: "launchfile_my_app",
		password: "s3cret-base64url_value",
		...overrides,
	};
}

/**
 * `.launchfile/state.json` sits inside the cloned repo and `loadState()`
 * JSON.parses it with no validation, so every value provision() reuses from it
 * is attacker-controlled. Argv execution keeps the shell out of these
 * commands, but `mysql -e` runs `;`-separated statements as root, so an
 * unguarded value is a statement injection with no shell involved.
 */
describe("MysqlProvisioner rejects unsafe values reused from state.json", () => {
	const cases = [
		{
			field: "dbName",
			value: "x`; DROP DATABASE victim; -- `",
			message: /Invalid database name/,
		},
		{
			field: "user",
			value: "u'; DROP DATABASE victim; -- ",
			message: /Invalid database user/,
		},
		{
			field: "password",
			value: "p'; DROP DATABASE victim; -- ",
			message: /Invalid database password/,
		},
	] as const;

	for (const { field, value, message } of cases) {
		it(`throws on a hostile ${field} and issues no SQL`, async () => {
			const { commands, deps } = recorder();
			const provisioner = new MysqlProvisioner(deps);

			await expect(
				provisioner.provision(REQ, OPTS, state({ [field]: value })),
			).rejects.toThrow(message);

			expect(commands.filter((c) => c.includes("-e"))).toEqual([]);
		});
	}

	it("keeps the rejected password out of the error message", async () => {
		const { deps } = recorder();
		const password = "p'; DROP DATABASE victim; -- ";

		await expect(
			new MysqlProvisioner(deps).provision(REQ, OPTS, state({ password })),
		).rejects.toThrow(
			expect.objectContaining({
				message: expect.not.stringContaining("DROP DATABASE"),
			}),
		);
	});
});

describe("MysqlProvisioner reuses a clean state file", () => {
	it("issues the create and grant statements with the stored values", async () => {
		const { commands, deps } = recorder();

		const result = await new MysqlProvisioner(deps).provision(
			REQ,
			OPTS,
			state(),
		);

		expect(commands).toContain(
			"mysql -h localhost -u root -e CREATE DATABASE IF NOT EXISTS `launchfile_my_app`;",
		);
		expect(commands).toContain(
			"mysql -h localhost -u root -e GRANT ALL PRIVILEGES ON `launchfile_my_app`.* TO 'launchfile_my_app'@'localhost';",
		);
		expect(result.properties.url).toBe(
			"mysql://launchfile_my_app:s3cret-base64url_value@localhost:3306/launchfile_my_app",
		);
	});

	it("provisions a first run with no state file", async () => {
		const { commands, deps } = recorder();

		await new MysqlProvisioner(deps).provision(REQ, OPTS);

		expect(commands).toContain(
			"mysql -h localhost -u root -e CREATE DATABASE IF NOT EXISTS `launchfile_my_app`;",
		);
	});
});

describe("MysqlProvisioner.destroy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("skips the drop and warns once per rejected identifier, without echoing it", async () => {
		const { commands, deps } = recorder();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const dbName = "x`; DROP DATABASE victim; -- `";
		const user = "u'; -- ";

		await new MysqlProvisioner(deps).destroy(
			state({ dbName, user }),
			DESTROY_OPTS,
		);

		expect(commands).toEqual([]);
		const warnings = warn.mock.calls.map((args) => args.join(" "));
		expect(warnings).toEqual([
			"  ! mysql: left a database in place — its name in state.json is not a safe identifier",
			"  ! mysql: left the database user in place — its name in state.json is not a safe identifier",
		]);
		for (const w of warnings) {
			expect(w).not.toContain(dbName);
			expect(w).not.toContain(user);
			expect(w).not.toContain("s3cret-base64url_value");
		}
	});

	it("does not warn when the user is absent and the database is safe", async () => {
		const { commands, deps } = recorder();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await new MysqlProvisioner(deps).destroy(
			state({ user: undefined }),
			DESTROY_OPTS,
		);

		expect(commands).toEqual([
			"mysql -h localhost -u root -e DROP DATABASE IF EXISTS `launchfile_my_app`;",
		]);
		expect(warn).not.toHaveBeenCalled();
	});

	it("drops the database and user when both are safe", async () => {
		const { commands, deps } = recorder();

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await new MysqlProvisioner(deps).destroy(state(), DESTROY_OPTS);

		expect(warn).not.toHaveBeenCalled();
		expect(commands).toEqual([
			"mysql -h localhost -u root -e DROP DATABASE IF EXISTS `launchfile_my_app`;",
			"mysql -h localhost -u root -e DROP USER IF EXISTS 'launchfile_my_app'@'localhost';",
		]);
	});
});

describe("MysqlProvisioner named `database` uses (SPEC.md § Resource uses)", () => {
	it("creates and grants each named database as <instance>_<name> the way it does the app's, and records them in state", async () => {
		const { commands, deps } = recorder();
		const provisioner = new MysqlProvisioner(deps);

		const { state } = await provisioner.provision(REQ, { ...OPTS, databases: ["event-log"] });

		expect(commands).toContain("mysql -h localhost -u root -e CREATE DATABASE IF NOT EXISTS `launchfile_my_app_event_log`;");
		expect(commands).toContain(
			"mysql -h localhost -u root -e GRANT ALL PRIVILEGES ON `launchfile_my_app_event_log`.* TO 'launchfile_my_app'@'localhost';",
		);
		expect(state.databases).toEqual(["launchfile_my_app_event_log"]);
	});

	it("drops the named databases it created on destroy, skipping an unsafe stored name", async () => {
		const { commands, deps } = recorder();
		const provisioner = new MysqlProvisioner(deps);

		await provisioner.destroy(
			state({ databases: ["launchfile_my_app_event_log", "x`; DROP DATABASE victim; -- `"] }),
			DESTROY_OPTS,
		);

		expect(commands.filter((c) => c.includes("DROP DATABASE"))).toEqual([
			"mysql -h localhost -u root -e DROP DATABASE IF EXISTS `launchfile_my_app`;",
			"mysql -h localhost -u root -e DROP DATABASE IF EXISTS `launchfile_my_app_event_log`;",
		]);
	});
});

/**
 * D-65 rule 3: a provider covers every declared use or refuses, naming the
 * entry, the token and the name. The CREATE DATABASE backing a named
 * `database` use is therefore not tolerated the way the app's own is.
 */
describe("MysqlProvisioner refuses a named `database` use whose CREATE DATABASE fails", () => {
	const NAMED_CREATE =
		"mysql -h localhost -u root -e CREATE DATABASE IF NOT EXISTS `launchfile_my_app_event_log`;";
	const createFails = (cmd: string) =>
		cmd === NAMED_CREATE
			? { exitCode: 1, stderr: "ERROR 1044 (42000) at line 1: Access denied for user 'root'@'localhost' to database 'launchfile_my_app_event_log'\n" }
			: undefined;

	it("throws naming the entry, the token and the name, with mysql's stderr", async () => {
		const { commands, deps } = recorder(createFails);
		const provisioner = new MysqlProvisioner(deps);

		await expect(
			provisioner.provision({ type: "mysql", name: "main" } as NormalizedRequirement, { ...OPTS, databases: ["event-log"] }),
		).rejects.toThrow(
			/^Refused: main: database: event-log — could not create database "launchfile_my_app_event_log" \(Command failed: mysql [\s\S]*Access denied/,
		);
		// Nothing is granted on a database that was not created.
		expect(commands.filter((c) => c.includes("GRANT") && c.includes("event_log"))).toEqual([]);
	});

	it("still tolerates a failing CREATE DATABASE for the app's own database", async () => {
		const { commands, deps } = recorder((cmd) =>
			cmd === "mysql -h localhost -u root -e CREATE DATABASE IF NOT EXISTS `launchfile_my_app`;"
				? { exitCode: 1, stderr: "ERROR 1044 (42000): Access denied\n" }
				: undefined,
		);
		const provisioner = new MysqlProvisioner(deps);

		const { state } = await provisioner.provision(REQ, { ...OPTS, databases: ["event-log"] });

		expect(commands).toContain(NAMED_CREATE);
		expect(state.databases).toEqual(["launchfile_my_app_event_log"]);
	});
});

/**
 * A database named on an earlier run and absent from this one is never
 * dropped by `up`: a one-line `uses:` edit must not destroy data. It stays in
 * `state.databases`, said out loud, so `destroy` still removes it (#521 item 1).
 */
describe("MysqlProvisioner keeps a database that vanished from the named uses", () => {
	const STORED = state({ databases: ["launchfile_my_app_audit_log", "launchfile_my_app_event_log"] });

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("records the vanished database after the current ones and issues no DROP", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { commands, deps } = recorder();
		const provisioner = new MysqlProvisioner(deps);

		const result = await provisioner.provision(REQ, { ...OPTS, databases: ["event-log"] }, STORED);

		expect(result.state.databases).toEqual(["launchfile_my_app_event_log", "launchfile_my_app_audit_log"]);
		expect(commands.filter((c) => c.includes("DROP"))).toEqual([]);
		// The vanished one is neither created nor granted — it is only remembered.
		expect(commands.filter((c) => c.includes("launchfile_my_app_audit_log"))).toEqual([]);
	});

	it("warns naming the vanished database and the entry", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { deps } = recorder();
		const provisioner = new MysqlProvisioner(deps);

		await provisioner.provision(
			{ type: "mysql", name: "main" } as NormalizedRequirement,
			{ ...OPTS, databases: ["event-log"] },
			STORED,
		);

		expect(warn.mock.calls.map(([line]) => line)).toEqual([
			'  ! mysql: database "launchfile_my_app_audit_log" is no longer a named use of main — kept; `destroy` drops it',
		]);
	});

	it("keeps an unsafe stored name for destroy to judge, without echoing it", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { commands, deps } = recorder();
		const provisioner = new MysqlProvisioner(deps);
		const hostile = "x`; DROP DATABASE victim; -- `";

		const result = await provisioner.provision(REQ, OPTS, state({ databases: [hostile] }));

		expect(result.state.databases).toEqual([hostile]);
		expect(commands.some((c) => c.includes("victim"))).toBe(false);
		expect(warn.mock.calls.map(([line]) => line)).toEqual([
			"  ! mysql: database (unsafe name in state.json) is no longer a named use of mysql — kept; `destroy` drops it",
		]);
	});
});

/**
 * P-13: an entry with no named `database` use produces byte-identical output
 * — the same statements in the same order and the same state shape.
 */
describe("MysqlProvisioner unnamed entry is unchanged (P-13)", () => {
	it("issues exactly the instance sequence and records no `databases` key", async () => {
		const { commands, deps } = recorder();

		const result = await new MysqlProvisioner(deps).provision(REQ, OPTS, state());

		expect(commands).toEqual([
			"mysqladmin ping -h localhost --silent",
			"mysql -h localhost -u root -e CREATE DATABASE IF NOT EXISTS `launchfile_my_app`;",
			"mysql -h localhost -u root -e CREATE USER IF NOT EXISTS 'launchfile_my_app'@'localhost' IDENTIFIED BY 's3cret-base64url_value';",
			"mysql -h localhost -u root -e GRANT ALL PRIVILEGES ON `launchfile_my_app`.* TO 'launchfile_my_app'@'localhost';",
		]);
		expect(result.state).toEqual(state({ name: "mysql" }));
	});
});
