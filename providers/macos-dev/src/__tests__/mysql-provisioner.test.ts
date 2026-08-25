import type { NormalizedRequirement } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { MysqlProvisioner } from "../resources/mysql.js";
import type { ProvisionOpts } from "../resources/types.js";
import type { ResourceState } from "../state.js";

const REQ = { type: "mysql" } as NormalizedRequirement;
const OPTS = { appName: "my-app" } as ProvisionOpts;

/**
 * Records every command issued, flattened to `cmd arg arg` so the assertions
 * stay readable; the provisioner passes argv arrays.
 */
function recorder() {
	const commands: string[] = [];
	const flatten = (cmd: string, args: string[]) => [cmd, ...args].join(" ");
	const shell = async (cmd: string, args: string[]) => {
		commands.push(flatten(cmd, args));
		return { exitCode: 0, stdout: "", stderr: "" };
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
	it("skips the drop when the stored identifier is unsafe", async () => {
		const { commands, deps } = recorder();

		await new MysqlProvisioner(deps).destroy(
			state({ dbName: "x`; DROP DATABASE victim; -- `", user: "u'; -- " }),
		);

		expect(commands).toEqual([]);
	});

	it("drops the database and user when both are safe", async () => {
		const { commands, deps } = recorder();

		await new MysqlProvisioner(deps).destroy(state());

		expect(commands).toEqual([
			"mysql -h localhost -u root -e DROP DATABASE IF EXISTS `launchfile_my_app`;",
			"mysql -h localhost -u root -e DROP USER IF EXISTS 'launchfile_my_app'@'localhost';",
		]);
	});
});
