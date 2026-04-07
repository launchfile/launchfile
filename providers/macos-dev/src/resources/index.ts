/**
 * Resource provisioner registry.
 *
 * Maps resource type names to their provisioner implementations.
 */

import type { ResourceProvisioner } from "./types.js";
import { PostgresProvisioner } from "./postgres.js";
import { RedisProvisioner } from "./redis.js";
import { SqliteProvisioner } from "./sqlite.js";
import { MysqlProvisioner } from "./mysql.js";

const provisioners: Record<string, ResourceProvisioner> = {
	postgres: new PostgresProvisioner(),
	redis: new RedisProvisioner(),
	sqlite: new SqliteProvisioner(),
	mysql: new MysqlProvisioner(),
	mariadb: new MysqlProvisioner(), // MariaDB is MySQL-compatible
};

export function getProvisioner(type: string): ResourceProvisioner | undefined {
	return provisioners[type];
}

export function supportedResourceTypes(): string[] {
	return Object.keys(provisioners);
}

export type { ResourceProvisioner, ResourceProperties, ProvisionOpts } from "./types.js";
