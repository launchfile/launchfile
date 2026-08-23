/**
 * Postgres resource provisioner via Homebrew.
 *
 * Strategy:
 * - Check if postgres is already running via `brew services list`
 * - If not, install and start via brew
 * - Create an app-specific database and user
 * - Return connection properties
 */

import type { NormalizedRequirement } from "@launchfile/sdk";
import { shell, shellOk } from "../shell.js";
import { generatePassword } from "../secret-generator.js";
import type { ResourceState } from "../state.js";
import type {
	ProvisionOpts,
	ResourceProperties,
	ResourceProvisioner,
	ShellRunner,
} from "./types.js";

export type { ShellRunner };

const DEFAULT_PORT = 5432;
const DEFAULT_HOST = "localhost";
const READY_TIMEOUT_SECONDS = 10;

// Security: validate identifiers before interpolating into shell/SQL commands.
// Only alphanumeric + underscore — safe for SQL identifiers and shell args.
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export class PostgresProvisioner implements ResourceProvisioner {
	readonly type = "postgres";
	readonly #shell: ShellRunner["shell"];
	readonly #shellOk: ShellRunner["shellOk"];

	constructor(deps: Partial<ShellRunner> = {}) {
		this.#shell = deps.shell ?? shell;
		this.#shellOk = deps.shellOk ?? shellOk;
	}

	async isRunning(): Promise<boolean> {
		return this.#shellOk("pg_isready -q");
	}

	async provision(
		req: NormalizedRequirement,
		opts: ProvisionOpts,
		existingState?: ResourceState,
	): Promise<{ properties: ResourceProperties; state: ResourceState }> {
		// Ensure postgres is running
		if (!(await this.isRunning())) {
			console.log("  Starting PostgreSQL via brew...");
			// Try to start; if not installed, install first
			const started = await this.#shellOk("brew services start postgresql");
			if (!started) {
				// Try versioned formula
				await this.#shell("brew install postgresql@16");
				await this.#shell("brew services start postgresql@16");
			}
		}

		// pg_isready blocks until the server answers or the timeout expires, so a
		// false here means Postgres never came up — every psql call below would
		// fail with a connection error that says nothing about the real cause.
		const ready = await this.#shellOk(
			`pg_isready --timeout=${READY_TIMEOUT_SECONDS}`,
		);
		if (!ready) {
			throw new Error(
				`PostgreSQL did not accept connections within ${READY_TIMEOUT_SECONDS}s. ` +
					`Check \`brew services list\` and \`pg_isready\`.`,
			);
		}

		// Determine database and user names
		const resourceName = req.name ?? req.type;
		const safeName = opts.appName.replace(/-/g, "_");
		const dbName = existingState?.dbName ?? `launchfile_${safeName}`;
		const user = existingState?.user ?? `launchfile_${safeName}`;
		// Security: both are interpolated into the psql commands below. A schema-validated
		// app name can never fail this, but existingState comes from the on-disk state file,
		// which is JSON.parse'd without validation (state.ts).
		if (!SAFE_IDENTIFIER.test(dbName)) throw new Error("Invalid database name");
		if (!SAFE_IDENTIFIER.test(user)) throw new Error("Invalid database user");
		const password = existingState?.password ?? generatePassword();
		const port = DEFAULT_PORT;

		// Create user (idempotent)
		await this.#shell(
			`psql -h ${DEFAULT_HOST} -p ${port} postgres -c "DO \\$\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${user}') THEN CREATE ROLE ${user} WITH LOGIN PASSWORD '${password}' CREATEDB; END IF; END \\$\\$;"`,
			// silent: this command embeds the generated DB password; don't echo it (CWE-532).
			{ allowFailure: true, silent: true },
		);

		// Create database (idempotent)
		const dbExists = await this.#shellOk(
			`psql -h ${DEFAULT_HOST} -p ${port} postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`,
		);
		if (!dbExists) {
			await this.#shell(
				`createdb -h ${DEFAULT_HOST} -p ${port} -O ${user} ${dbName}`,
				{ allowFailure: true },
			);
		}

		// Handle extensions from config
		// Security: extension names come from Launchfile config (untrusted input).
		// Validate each against SAFE_IDENTIFIER before interpolating into SQL.
		const extensions = req.config?.extensions;
		if (Array.isArray(extensions)) {
			for (const ext of extensions) {
				if (typeof ext !== "string") continue;
				if (!SAFE_IDENTIFIER.test(ext)) {
					console.warn(`  Skipping invalid extension name: ${ext}`);
					continue;
				}
				await this.#shell(
					`psql -h ${DEFAULT_HOST} -p ${port} ${dbName} -c "CREATE EXTENSION IF NOT EXISTS \\"${ext}\\";"`,
					{ allowFailure: true },
				);
			}
		}

		const url = `postgresql://${user}:${password}@${DEFAULT_HOST}:${port}/${dbName}`;

		const properties: ResourceProperties = {
			url,
			host: DEFAULT_HOST,
			port,
			user,
			password,
			name: dbName,
		};

		const state: ResourceState = {
			type: "postgres",
			name: resourceName,
			brewService: "postgresql",
			port,
			dbName,
			user,
			password,
		};

		return { properties, state };
	}

	async destroy(state: ResourceState): Promise<void> {
		// Security: state values come from disk (state.json) — validate before SQL interpolation
		if (state.dbName && SAFE_IDENTIFIER.test(state.dbName)) {
			await this.#shell(`dropdb -h ${DEFAULT_HOST} --if-exists ${state.dbName}`, {
				allowFailure: true,
			});
		}
		if (state.user && SAFE_IDENTIFIER.test(state.user)) {
			await this.#shell(
				`psql -h ${DEFAULT_HOST} postgres -c "DROP ROLE IF EXISTS ${state.user};"`,
				{ allowFailure: true },
			);
		}
		// Don't stop the brew service — it's shared
	}
}
