/**
 * Resource provisioner registry.
 *
 * Maps resource type names to their provisioner implementations.
 */

import type { ResourceProvisioner, ShellRunner } from "./types.js";
import { PostgresProvisioner } from "./postgres.js";
import { RedisProvisioner } from "./redis.js";
import { SqliteProvisioner } from "./sqlite.js";
import { MysqlProvisioner } from "./mysql.js";

/**
 * One factory per supported type, rather than one instance, so a caller can
 * supply the shell a provisioner runs against. The conformance test
 * (`__tests__/resource-conformance.test.ts`) is the caller that needs it: it
 * walks this registry so the check covers every supported type, and no type can
 * fall out of the check by being listed in only one of two places.
 *
 * The map has a null prototype, so a lookup keyed by a resource type read out
 * of a Launchfile resolves to `undefined` for `constructor`, `__proto__` and
 * every other `Object.prototype` key rather than an inherited value.
 */
const factories: Record<
	string,
	(deps?: Partial<ShellRunner>) => ResourceProvisioner
> = Object.assign(Object.create(null), {
	postgres: (deps?: Partial<ShellRunner>) => new PostgresProvisioner(deps),
	redis: (deps?: Partial<ShellRunner>) => new RedisProvisioner(deps),
	sqlite: () => new SqliteProvisioner(),
	mysql: (deps?: Partial<ShellRunner>) => new MysqlProvisioner(deps),
	mariadb: (deps?: Partial<ShellRunner>) => new MysqlProvisioner(deps), // MariaDB is MySQL-compatible
});

export function getProvisioner(
	type: string,
	deps?: Partial<ShellRunner>,
): ResourceProvisioner | undefined {
	return factories[type]?.(deps);
}

export function supportedResourceTypes(): string[] {
	return Object.keys(factories);
}

export type {
	ResourceProvisioner,
	ResourceProperties,
	ProvisionOpts,
	ShellRunner,
} from "./types.js";
