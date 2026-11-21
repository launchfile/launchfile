/**
 * Caller-chosen container ports for the SQL backing services this provider
 * provisions (`ComposeOpts.resourcePorts`, #568).
 *
 * The port is the platform's choice (P-11), and an app reads it through the
 * standard `port` property (D-7, D-46). Every engine's default is also what an
 * entry gets when it ignores `$port` and hard-codes the number, so a run on
 * the default cannot tell a correct binding from a lucky one. A caller that
 * picks a different port makes such an entry fail to connect.
 *
 * Only the container-side port moves: what the engine listens on, and what the
 * `port` and `url` properties publish to the app. Host ports the provider
 * publishes for the app's own endpoints are a separate allocation and are not
 * affected.
 *
 * This module has no dependencies so the catalog harness can import it as-is.
 */

export const RESOURCE_PORT_TYPES = ["postgres", "mysql", "mariadb"] as const;

export type ResourcePortType = (typeof RESOURCE_PORT_TYPES)[number];

/** Container port per engine; an absent engine keeps its default. */
export type ResourcePorts = Partial<Record<ResourcePortType, number>>;

/** What the engine listens on when the caller picks nothing. */
export const DEFAULT_RESOURCE_PORTS: Readonly<
	Record<ResourcePortType, number>
> = {
	postgres: 5432,
	mysql: 3306,
	mariadb: 3306,
};

/**
 * A `resourcePorts` entry this provider refuses: a type it has no port for, or
 * a value that is not an integer from 1 to 65535. Refused rather than
 * defaulted, because a silent fallback to the engine default would hide the
 * very blind spot the option exists to expose.
 */
export class InvalidResourcePortError extends Error {
	readonly type: string;
	readonly value: unknown;

	constructor(type: string, value: unknown, reason: string) {
		super(`resourcePorts.${type}: ${reason}`);
		this.name = "InvalidResourcePortError";
		this.type = type;
		this.value = value;
	}
}

/**
 * Check every entry of `resourcePorts` and return the validated map. An
 * absent or empty option returns an empty map, which every factory treats as
 * "use the engine default", so the generator's output is unchanged.
 *
 * The parameter is `unknown`-tolerant on purpose: a CLI flag or a JSON
 * config reaches this with no type guarantee, and the error names the entry.
 */
export function validateResourcePorts(resourcePorts: unknown): ResourcePorts {
	if (resourcePorts === undefined || resourcePorts === null) return {};
	if (typeof resourcePorts !== "object" || Array.isArray(resourcePorts)) {
		throw new InvalidResourcePortError(
			"*",
			resourcePorts,
			`expected an object keyed by ${RESOURCE_PORT_TYPES.join(", ")}`,
		);
	}
	const valid: ResourcePorts = {};
	for (const [type, value] of Object.entries(resourcePorts)) {
		if (!(RESOURCE_PORT_TYPES as readonly string[]).includes(type)) {
			throw new InvalidResourcePortError(
				type,
				value,
				`no such backing-service type — supported: ${RESOURCE_PORT_TYPES.join(", ")}`,
			);
		}
		if (value === undefined) continue;
		if (
			typeof value !== "number" ||
			!Number.isInteger(value) ||
			value < 1 ||
			value > 65535
		) {
			throw new InvalidResourcePortError(
				type,
				value,
				`expected an integer from 1 to 65535, got ${JSON.stringify(value)}`,
			);
		}
		valid[type as ResourcePortType] = value;
	}
	return valid;
}
