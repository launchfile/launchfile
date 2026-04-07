/**
 * MySQL resource provisioner via Homebrew.
 */

import type { NormalizedRequirement } from "@launchfile/sdk";
import { shell, shellOk } from "../shell.js";
import { generatePassword } from "../secret-generator.js";
import type { ResourceState } from "../state.js";
import type { ProvisionOpts, ResourceProperties, ResourceProvisioner } from "./types.js";

const DEFAULT_PORT = 3306;
const DEFAULT_HOST = "localhost";

export class MysqlProvisioner implements ResourceProvisioner {
	readonly type = "mysql";

	async isRunning(): Promise<boolean> {
		return shellOk("mysqladmin ping -h localhost --silent");
	}

	async provision(
		req: NormalizedRequirement,
		opts: ProvisionOpts,
		existingState?: ResourceState,
	): Promise<{ properties: ResourceProperties; state: ResourceState }> {
		if (!(await this.isRunning())) {
			console.log("  Starting MySQL via brew...");
			const started = await shellOk("brew services start mysql");
			if (!started) {
				await shell("brew install mysql");
				await shell("brew services start mysql");
			}
		}

		const resourceName = req.name ?? req.type;
		const safeName = opts.appName.replace(/-/g, "_");
		const dbName = existingState?.dbName ?? `launchfile_${safeName}`;
		const user = existingState?.user ?? `launchfile_${safeName}`;
		const password = existingState?.password ?? generatePassword();
		const port = DEFAULT_PORT;

		// Create database and user (idempotent)
		await shell(
			`mysql -h ${DEFAULT_HOST} -u root -e "CREATE DATABASE IF NOT EXISTS \\\`${dbName}\\\`;"`,
			{ allowFailure: true },
		);
		await shell(
			`mysql -h ${DEFAULT_HOST} -u root -e "CREATE USER IF NOT EXISTS '${user}'@'${DEFAULT_HOST}' IDENTIFIED BY '${password}';"`,
			{ allowFailure: true },
		);
		await shell(
			`mysql -h ${DEFAULT_HOST} -u root -e "GRANT ALL PRIVILEGES ON \\\`${dbName}\\\`.* TO '${user}'@'${DEFAULT_HOST}';"`,
			{ allowFailure: true },
		);

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
		};

		return { properties, state };
	}

	async destroy(state: ResourceState): Promise<void> {
		if (state.dbName) {
			await shell(
				`mysql -h ${DEFAULT_HOST} -u root -e "DROP DATABASE IF EXISTS \\\`${state.dbName}\\\`;"`,
				{ allowFailure: true },
			);
		}
		if (state.user) {
			await shell(
				`mysql -h ${DEFAULT_HOST} -u root -e "DROP USER IF EXISTS '${state.user}'@'${DEFAULT_HOST}';"`,
				{ allowFailure: true },
			);
		}
	}
}
