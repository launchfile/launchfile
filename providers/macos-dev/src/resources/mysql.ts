/**
 * MySQL resource provisioner via Homebrew.
 */

import type { NormalizedRequirement } from "@launchfile/sdk";
import { shell, shellOk } from "../shell.js";
import { generatePassword } from "../secret-generator.js";
import {
	assertSafeIdentifier,
	assertSafePassword,
	SAFE_IDENTIFIER,
} from "./identifiers.js";
import type { ResourceState } from "../state.js";
import type {
	DestroyOpts,
	ProvisionOpts,
	ProvisionResult,
	ResourceProperties,
	ResourceProvisioner,
	ShellRunner,
} from "./types.js";
import { namedDatabase } from "./uses.js";
import { serverVersion, versionWarning } from "./version.js";

const DEFAULT_PORT = 3306;
const DEFAULT_HOST = "localhost";

/** Connection flags shared by every mysql invocation, as argv elements. */
function mysqlArgs(): string[] {
	return ["-h", DEFAULT_HOST, "-u", "root"];
}

export class MysqlProvisioner implements ResourceProvisioner {
	readonly type = "mysql";
	readonly #shell: ShellRunner["shell"];
	readonly #shellOk: ShellRunner["shellOk"];

	constructor(deps: Partial<ShellRunner> = {}) {
		this.#shell = deps.shell ?? shell;
		this.#shellOk = deps.shellOk ?? shellOk;
	}

	async isRunning(): Promise<boolean> {
		return this.#shellOk("mysqladmin", [
			"ping",
			"-h",
			DEFAULT_HOST,
			"--silent",
		]);
	}

	async provision(
		req: NormalizedRequirement,
		opts: ProvisionOpts,
		existingState?: ResourceState,
	): Promise<ProvisionResult> {
		if (!(await this.isRunning())) {
			console.log("  Starting MySQL via brew...");
			const started = await this.#shellOk("brew", [
				"services",
				"start",
				"mysql",
			]);
			if (!started) {
				await this.#shell("brew", ["install", "mysql"]);
				await this.#shell("brew", ["services", "start", "mysql"]);
			}
		}

		const versionWarnings = req.version ? await this.#versionWarnings(req) : [];

		const resourceName = req.name ?? req.type;
		const safeName = opts.appName.replace(/-/g, "_");
		const dbName = existingState?.dbName ?? `launchfile_${safeName}`;
		const user = existingState?.user ?? `launchfile_${safeName}`;
		const password = existingState?.password ?? generatePassword();
		// Security: all three are interpolated into the SQL below, and `mysql -e`
		// runs `;`-separated statements as root. Fresh values cannot fail these
		// checks; values reused from state.json are unvalidated JSON (state.ts).
		assertSafeIdentifier(dbName, "database name");
		assertSafeIdentifier(user, "database user");
		assertSafePassword(password);
		const port = DEFAULT_PORT;

		// Create database and user (idempotent)
		await this.#shell(
			"mysql",
			[...mysqlArgs(), "-e", `CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`],
			{ allowFailure: true },
		);
		await this.#shell(
			"mysql",
			[
				...mysqlArgs(),
				"-e",
				`CREATE USER IF NOT EXISTS '${user}'@'${DEFAULT_HOST}' IDENTIFIED BY '${password}';`,
			],
			// silent: this command embeds the generated DB password; don't echo it (CWE-532).
			{ allowFailure: true, silent: true },
		);
		await this.#shell(
			"mysql",
			[
				...mysqlArgs(),
				"-e",
				`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${user}'@'${DEFAULT_HOST}';`,
			],
			{ allowFailure: true },
		);

		// Named `database` uses (SPEC.md § Resource uses): one more database per
		// name, `<instance>_<name>`, created and granted the same way as the
		// app's own. A CREATE DATABASE that fails aborts `up`, naming the entry,
		// the token and the name, the way any provisioning failure here does: a
		// use the provider could not create is never handed to the app as a URL.
		// Security: a use name is schema-validated (^[a-z][a-z0-9-]*$) and the
		// hyphens become underscores, so the identifier check cannot fail on a
		// name that reached here through the parser; it guards the SQL below
		// all the same.
		const databases: string[] = [];
		for (const name of opts.databases ?? []) {
			const database = namedDatabase(dbName, name);
			assertSafeIdentifier(database, "database name");
			databases.push(database);
			try {
				await this.#shell("mysql", [
					...mysqlArgs(),
					"-e",
					`CREATE DATABASE IF NOT EXISTS \`${database}\`;`,
				]);
			} catch (error) {
				throw new Error(
					`Refused: ${resourceName}: database: ${name} — could not create database "${database}" ` +
						`(${error instanceof Error ? error.message : String(error)})`,
					{ cause: error },
				);
			}
			await this.#shell(
				"mysql",
				[
					...mysqlArgs(),
					"-e",
					`GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${user}'@'${DEFAULT_HOST}';`,
				],
				{ allowFailure: true },
			);
		}
		// A database this entry named on an earlier run and no longer does
		// stays recorded: dropping it here would destroy data on a one-line
		// `uses:` edit with no undo. `destroy` is the only path that drops it.
		const vanished = (existingState?.databases ?? []).filter(
			(database) => !databases.includes(database),
		);
		for (const database of vanished) {
			// Security: the stored name is unvalidated JSON (state.ts); an unsafe
			// one is never echoed.
			const label = SAFE_IDENTIFIER.test(database)
				? `"${database}"`
				: "(unsafe name in state.json)";
			console.warn(
				`  ! mysql: database ${label} is no longer a named use of ${resourceName} — kept; \`destroy\` drops it`,
			);
		}
		databases.push(...vanished);

		const url = `mysql://${user}:${password}@${DEFAULT_HOST}:${port}/${dbName}`;

		const properties: ResourceProperties = {
			url,
			host: DEFAULT_HOST,
			port,
			user,
			password,
			name: dbName,
		};

		const state: ResourceState = {
			type: "mysql",
			name: resourceName,
			brewService: "mysql",
			port,
			dbName,
			user,
			password,
			...(databases.length > 0 ? { databases } : {}),
		};

		return { properties, state, warnings: versionWarnings };
	}

	/**
	 * The `requires[].version` report, against the version the server reports.
	 * One server on port 3306 serves both `mysql` and `mariadb` entries, and
	 * the two number their releases independently, so a version is compared
	 * only when the server is the product the entry names.
	 */
	async #versionWarnings(req: NormalizedRequirement): Promise<string[]> {
		const result = await this.#shell(
			"mysql",
			[...mysqlArgs(), "-N", "-e", "SELECT VERSION();"],
			{ allowFailure: true, silent: true },
		);
		const output = result.exitCode === 0 ? result.stdout.trim() : "";
		const isMariadb = /mariadb/i.test(output);
		const product = isMariadb ? "MariaDB" : "MySQL";
		const server = output
			? `the ${product} server on ${DEFAULT_HOST}:${DEFAULT_PORT}`
			: `the server on ${DEFAULT_HOST}:${DEFAULT_PORT}`;
		const running =
			output && isMariadb === (req.type === "mariadb") ? serverVersion(output) : undefined;
		const warning = versionWarning(req, server, running);
		return warning ? [warning] : [];
	}

	async destroy(state: ResourceState, _opts: DestroyOpts): Promise<void> {
		// Security: state values come from disk (state.json) — validate before SQL
		// interpolation. A rejected value is never echoed: it is attacker-controlled.
		for (const database of [state.dbName, ...(state.databases ?? [])]) {
			if (!database) continue;
			if (!SAFE_IDENTIFIER.test(database)) {
				console.warn(
					"  ! mysql: left a database in place — its name in state.json is not a safe identifier",
				);
				continue;
			}
			await this.#shell(
				"mysql",
				[...mysqlArgs(), "-e", `DROP DATABASE IF EXISTS \`${database}\`;`],
				{ allowFailure: true },
			);
		}
		if (state.user && !SAFE_IDENTIFIER.test(state.user)) {
			console.warn(
				"  ! mysql: left the database user in place — its name in state.json is not a safe identifier",
			);
		} else if (state.user) {
			await this.#shell(
				"mysql",
				[
					...mysqlArgs(),
					"-e",
					`DROP USER IF EXISTS '${state.user}'@'${DEFAULT_HOST}';`,
				],
				{ allowFailure: true },
			);
		}
	}
}
