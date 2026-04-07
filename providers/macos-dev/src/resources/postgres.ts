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
import type { ProvisionOpts, ResourceProperties, ResourceProvisioner } from "./types.js";

const DEFAULT_PORT = 5432;
const DEFAULT_HOST = "localhost";

// Security: validate identifiers before interpolating into shell/SQL commands.
// Only alphanumeric + underscore — safe for SQL identifiers and shell args.
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export class PostgresProvisioner implements ResourceProvisioner {
	readonly type = "postgres";

	async isRunning(): Promise<boolean> {
		return shellOk("pg_isready -q");
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
			const started = await shellOk("brew services start postgresql");
			if (!started) {
				// Try versioned formula
				await shell("brew install postgresql@16");
				await shell("brew services start postgresql@16");
			}
		}

		// Wait for ready
		await shell("pg_isready --timeout=10", { allowFailure: true });

		// Determine database and user names
		const resourceName = req.name ?? req.type;
		const safeName = opts.appName.replace(/-/g, "_");
		const dbName = existingState?.dbName ?? `launchfile_${safeName}`;
		const user = existingState?.user ?? `launchfile_${safeName}`;
		const password = existingState?.password ?? generatePassword();
		const port = DEFAULT_PORT;

		// Create user (idempotent)
		await shell(
			`psql -h ${DEFAULT_HOST} -p ${port} postgres -c "DO \\$\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${user}') THEN CREATE ROLE ${user} WITH LOGIN PASSWORD '${password}' CREATEDB; END IF; END \\$\\$;"`,
			{ allowFailure: true },
		);

		// Create database (idempotent)
		const dbExists = await shellOk(
			`psql -h ${DEFAULT_HOST} -p ${port} postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`,
		);
		if (!dbExists) {
			await shell(
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
				await shell(
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
			await shell(`dropdb -h ${DEFAULT_HOST} --if-exists ${state.dbName}`, {
				allowFailure: true,
			});
		}
		if (state.user && SAFE_IDENTIFIER.test(state.user)) {
			await shell(
				`psql -h ${DEFAULT_HOST} postgres -c "DROP ROLE IF EXISTS ${state.user};"`,
				{ allowFailure: true },
			);
		}
		// Don't stop the brew service — it's shared
	}
}
