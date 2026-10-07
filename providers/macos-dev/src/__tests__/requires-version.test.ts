/**
 * `requires[].version` reporting (PROVIDERS.md §10 item 8, D-74). This
 * provider never selects a version, so each provisioner compares a declared
 * range with the version its running server reports and returns a warning
 * for every range it cannot show is met. A satisfied range stays silent.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedRequirement } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { MysqlProvisioner } from "../resources/mysql.js";
import { PostgresProvisioner } from "../resources/postgres.js";
import { RedisProvisioner } from "../resources/redis.js";
import { SqliteProvisioner } from "../resources/sqlite.js";
import type { ProvisionOpts, ShellRunner } from "../resources/types.js";
import { serverVersion } from "../resources/version.js";

const OPTS = { appName: "my-app" } as ProvisionOpts;

/**
 * Every command succeeds. A command whose flattened argv contains a key of
 * `stdout` prints that value; `failing` commands exit 1 with no output.
 */
function runner(
	stdout: Record<string, string> = {},
	failing: string[] = [],
): { commands: string[]; deps: ShellRunner } {
	const commands: string[] = [];
	const flatten = (cmd: string, args: string[]) => [cmd, ...args].join(" ");
	const deps: ShellRunner = {
		shell: async (cmd: string, args: string[]) => {
			const line = flatten(cmd, args);
			commands.push(line);
			if (failing.some((f) => line.includes(f)))
				return { exitCode: 1, stdout: "", stderr: "" };
			const key = Object.keys(stdout).find((k) => line.includes(k));
			return {
				exitCode: 0,
				stdout: key ? (stdout[key] ?? "") : "",
				stderr: "",
			};
		},
		shellOk: async (cmd: string, args: string[]) => {
			commands.push(flatten(cmd, args));
			return true;
		},
	};
	return { commands, deps };
}

const req = (type: string, version?: string, name?: string) =>
	({
		type,
		...(version ? { version } : {}),
		...(name ? { name } : {}),
	}) as NormalizedRequirement;

describe("serverVersion", () => {
	it("reads the first dotted version a server prints", () => {
		expect(serverVersion("16.4 (Homebrew)")).toBe("16.4.0");
		expect(serverVersion("11.4.2-MariaDB")).toBe("11.4.2");
		expect(serverVersion("7.2.4")).toBe("7.2.4");
	});

	it("returns undefined when the output carries no version", () => {
		expect(serverVersion("")).toBeUndefined();
		expect(serverVersion("unknown")).toBeUndefined();
	});
});

describe("PostgresProvisioner requires[].version", () => {
	const SHOW = "SHOW server_version";

	it("stays silent when the running server satisfies the range", async () => {
		const { deps } = runner({ [SHOW]: "16.4 (Homebrew)\n" });
		const { warnings } = await new PostgresProvisioner(deps).provision(
			req("postgres", ">=15"),
			OPTS,
		);
		expect(warnings).toEqual([]);
	});

	it("warns when the running server does not satisfy the range", async () => {
		const { deps } = runner({ [SHOW]: "16.4 (Homebrew)\n" });
		const { warnings } = await new PostgresProvisioner(deps).provision(
			req("postgres", ">=17"),
			OPTS,
		);
		expect(warnings).toEqual([
			'requires[postgres]: declared version ">=17" is not satisfied — this provider uses ' +
				"the PostgreSQL server on localhost:5432, version 16.4.0, and does not select versions.",
		]);
	});

	it("warns that the range cannot be checked when the server reports no version", async () => {
		const { deps } = runner({}, [SHOW]);
		const { warnings } = await new PostgresProvisioner(deps).provision(
			req("postgres", ">=15"),
			OPTS,
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("cannot be checked");
		expect(warnings[0]).toContain(
			"read no postgres version from the PostgreSQL server",
		);
	});

	it("warns on a range it cannot parse rather than dropping it", async () => {
		const { deps } = runner({ [SHOW]: "16.4" });
		const { warnings } = await new PostgresProvisioner(deps).provision(
			req("postgres", "sixteen-ish", "primary-db"),
			OPTS,
		);
		expect(warnings).toEqual([
			'requires[primary-db]: declared version "sixteen-ish" is not a valid semver range — ' +
				"this provider cannot check it against the PostgreSQL server on localhost:5432.",
		]);
	});

	it("asks the server nothing and warns nothing when no version is declared", async () => {
		const { commands, deps } = runner();
		const { warnings } = await new PostgresProvisioner(deps).provision(
			req("postgres"),
			OPTS,
		);
		expect(warnings).toEqual([]);
		expect(commands.some((c) => c.includes(SHOW))).toBe(false);
	});
});

describe("MysqlProvisioner requires[].version", () => {
	const SELECT = "SELECT VERSION();";

	it("stays silent when the running MySQL satisfies a mysql range", async () => {
		const { deps } = runner({ [SELECT]: "8.4.2\n" });
		const { warnings } = await new MysqlProvisioner(deps).provision(
			req("mysql", ">=8"),
			OPTS,
		);
		expect(warnings).toEqual([]);
	});

	it("warns when the running MySQL does not satisfy the range", async () => {
		const { deps } = runner({ [SELECT]: "8.4.2\n" });
		const { warnings } = await new MysqlProvisioner(deps).provision(
			req("mysql", "^9"),
			OPTS,
		);
		expect(warnings).toEqual([
			'requires[mysql]: declared version "^9" is not satisfied — this provider uses ' +
				"the MySQL server on localhost:3306, version 8.4.2, and does not select versions.",
		]);
	});

	it("compares a mariadb range against a running MariaDB", async () => {
		const { deps } = runner({ [SELECT]: "11.4.2-MariaDB\n" });
		const { warnings } = await new MysqlProvisioner(deps).provision(
			req("mariadb", ">=10.6"),
			OPTS,
		);
		expect(warnings).toEqual([]);
	});

	it("does not compare a mariadb range against a MySQL version", async () => {
		// 8.4.2 is >=8, but it is a MySQL release number, not a MariaDB one.
		const { deps } = runner({ [SELECT]: "8.4.2\n" });
		const { warnings } = await new MysqlProvisioner(deps).provision(
			req("mariadb", ">=8"),
			OPTS,
		);
		expect(warnings).toEqual([
			'requires[mariadb]: declared version ">=8" cannot be checked — this provider does not ' +
				"select versions and read no mariadb version from the MySQL server on localhost:3306.",
		]);
	});
});

describe("RedisProvisioner requires[].version", () => {
	const INFO = "INFO server";
	const info = "# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n";

	it("stays silent when the running server satisfies the range", async () => {
		const { deps } = runner({ [INFO]: info });
		const { warnings } = await new RedisProvisioner(deps).provision(
			req("redis", "^7.0"),
			OPTS,
		);
		expect(warnings).toEqual([]);
	});

	it("warns when the running server does not satisfy the range", async () => {
		const { deps } = runner({ [INFO]: info });
		const { warnings } = await new RedisProvisioner(deps).provision(
			req("redis", ">=8"),
			OPTS,
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(
			'requires[redis]: declared version ">=8" is not satisfied',
		);
		expect(warnings[0]).toContain(
			"the Redis server on localhost:6379, version 7.2.4",
		);
	});

	it("warns that the range cannot be checked when INFO carries no version", async () => {
		const { deps } = runner({ [INFO]: "# Server\r\n" });
		const { warnings } = await new RedisProvisioner(deps).provision(
			req("redis", "^7.0"),
			OPTS,
		);
		expect(warnings[0]).toContain("cannot be checked");
	});

	it("queries the host and port the warning names", async () => {
		const { commands, deps } = runner({ [INFO]: info });
		const { warnings } = await new RedisProvisioner(deps).provision(
			req("redis", ">=8"),
			OPTS,
		);
		expect(commands).toContain("redis-cli -h localhost -p 6379 INFO server");
		expect(warnings[0]).toContain("localhost:6379");
	});
});

describe("SqliteProvisioner requires[].version", () => {
	it("warns that a declared range cannot be checked, naming what it provides", async () => {
		const projectDir = await mkdtemp(join(tmpdir(), "lf-sqlite-version-"));
		const { warnings } = await new SqliteProvisioner().provision(
			req("sqlite", ">=3.40"),
			{
				appName: "my-app",
				projectDir,
			},
		);
		expect(warnings).toEqual([
			'requires[sqlite]: declared version ">=3.40" cannot be checked — this provider does not ' +
				"select versions and provides only the database file, no SQLite library, so it reads no SQLite version.",
		]);
	});

	it("warns nothing when no version is declared", async () => {
		const projectDir = await mkdtemp(join(tmpdir(), "lf-sqlite-version-"));
		const { warnings } = await new SqliteProvisioner().provision(
			req("sqlite"),
			{
				appName: "my-app",
				projectDir,
			},
		);
		expect(warnings).toEqual([]);
	});
});
