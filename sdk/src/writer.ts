/**
 * Writer: NormalizedLaunch → clean YAML string.
 *
 * Collapses to shorthand when only the primary field is set:
 *   - { context: "." } → "."
 *   - { path: "/health" } → "/health"
 *   - { command: "node server.js" } → "node server.js"
 *   - { default: "8080" } → "8080"
 *   - { type: "postgres" } → "postgres"
 *   - { component: "backend" } → "backend"
 */

import { stringify } from "yaml";
import type {
	NormalizedLaunch,
	NormalizedComponent,
	NormalizedRequirement,
	NormalizedDependsOnEntry,
	NormalizedCommand,
	NormalizedBuild,
	NormalizedHealth,
	NormalizedEnvVar,
} from "./types.js";

/** Serialize a NormalizedLaunch to a YAML string */
export function writeLaunch(launch: NormalizedLaunch): string {
	const output = denormalizeLaunch(launch);
	return stringify(output, { lineWidth: 0 });
}

/** Convert normalized form back to the most compact valid Launch */
function denormalizeLaunch(launch: NormalizedLaunch): Record<string, unknown> {
	const componentNames = Object.keys(launch.components);
	const isSingle = componentNames.length === 1 && componentNames[0] === "default";

	const result: Record<string, unknown> = {};

	if (launch.version) result.version = launch.version;
	if (launch.generator) result.generator = launch.generator;
	result.name = launch.name;
	if (launch.description) result.description = launch.description;
	if (launch.secrets && Object.keys(launch.secrets).length > 0) result.secrets = launch.secrets;

	if (isSingle) {
		// Single-component — flatten to top level
		const comp = launch.components.default!;
		Object.assign(result, denormalizeComponent(comp));
	} else {
		// Multi-component
		const components: Record<string, unknown> = {};
		for (const [name, comp] of Object.entries(launch.components)) {
			components[name] = denormalizeComponent(comp);
		}
		result.components = components;
	}

	return result;
}

/** Denormalize a component, collapsing to shorthands where possible */
function denormalizeComponent(comp: NormalizedComponent): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	if (comp.runtime) result.runtime = comp.runtime;
	if (comp.image) result.image = comp.image;

	const build = denormalizeBuild(comp.build);
	if (build !== undefined) result.build = build;

	if (comp.provides?.length) result.provides = comp.provides;

	const requires = denormalizeRequirements(comp.requires);
	if (requires?.length) result.requires = requires;

	const supports = denormalizeRequirements(comp.supports);
	if (supports?.length) result.supports = supports;

	const env = denormalizeEnv(comp.env);
	if (env && Object.keys(env).length > 0) result.env = env;

	const commands = denormalizeCommands(comp.commands);
	if (commands && Object.keys(commands).length > 0) result.commands = commands;

	if (comp.outputs && Object.keys(comp.outputs).length > 0) result.outputs = comp.outputs;

	const health = denormalizeHealth(comp.health);
	if (health !== undefined) result.health = health;

	const depends_on = denormalizeDependsOn(comp.depends_on);
	if (depends_on?.length) result.depends_on = depends_on;

	if (comp.storage && Object.keys(comp.storage).length > 0) result.storage = comp.storage;
	if (comp.restart) result.restart = comp.restart;
	if (comp.schedule) result.schedule = comp.schedule;
	if (comp.singleton) result.singleton = comp.singleton;
	if (comp.platform) result.platform = comp.platform;
	if (comp.host) result.host = comp.host;

	return result;
}

// --- Shorthand collapsers ---

function denormalizeBuild(build: NormalizedBuild | undefined): string | Record<string, unknown> | undefined {
	if (!build) return undefined;
	// Collapse to string if only context is set
	if (build.context && !build.dockerfile && !build.target && !build.args && !build.secrets) {
		return build.context;
	}
	const result: Record<string, unknown> = {};
	if (build.context) result.context = build.context;
	if (build.dockerfile) result.dockerfile = build.dockerfile;
	if (build.target) result.target = build.target;
	if (build.args) result.args = build.args;
	if (build.secrets) result.secrets = build.secrets;
	return result;
}

function denormalizeRequirements(
	reqs: NormalizedRequirement[] | undefined,
): Array<string | Record<string, unknown>> | undefined {
	if (!reqs?.length) return undefined;
	return reqs.map((r) => {
		// Collapse to string if only type is set
		if (!r.name && !r.version && !r.config && !r.set_env) {
			return r.type;
		}
		const result: Record<string, unknown> = {};
		if (r.name) result.name = r.name;
		result.type = r.type;
		if (r.version) result.version = r.version;
		if (r.config) result.config = r.config;
		if (r.set_env) result.set_env = r.set_env;
		return result;
	});
}

function denormalizeEnv(
	env: Record<string, NormalizedEnvVar> | undefined,
): Record<string, unknown> | undefined {
	if (!env) return undefined;
	const result: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(env)) {
		// Collapse to scalar if only default is set
		if (
			val.default !== undefined &&
			!val.description &&
			!val.label &&
			!val.required &&
			!val.generator &&
			!val.sensitive
		) {
			result[key] = val.default;
		} else {
			const obj: Record<string, unknown> = {};
			if (val.default !== undefined) obj.default = val.default;
			if (val.description) obj.description = val.description;
			if (val.label) obj.label = val.label;
			if (val.required) obj.required = val.required;
			if (val.generator) obj.generator = val.generator;
			if (val.sensitive) obj.sensitive = val.sensitive;
			result[key] = obj;
		}
	}
	return result;
}

function denormalizeCommands(
	commands: Record<string, NormalizedCommand> | undefined,
): Record<string, unknown> | undefined {
	if (!commands) return undefined;
	const result: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(commands)) {
		// Collapse to string if only command is set
		if (!val.timeout) {
			result[key] = val.command;
		} else {
			result[key] = { command: val.command, timeout: val.timeout };
		}
	}
	return result;
}

function denormalizeHealth(health: NormalizedHealth | undefined): string | Record<string, unknown> | undefined {
	if (!health) return undefined;
	// Collapse to string if only path is set
	if (health.path && !health.command && !health.interval && !health.timeout && !health.retries && !health.start_period) {
		return health.path;
	}
	const result: Record<string, unknown> = {};
	if (health.path) result.path = health.path;
	if (health.command) result.command = health.command;
	if (health.interval) result.interval = health.interval;
	if (health.timeout) result.timeout = health.timeout;
	if (health.retries) result.retries = health.retries;
	if (health.start_period) result.start_period = health.start_period;
	return result;
}

function denormalizeDependsOn(
	deps: NormalizedDependsOnEntry[] | undefined,
): Array<string | Record<string, unknown>> | undefined {
	if (!deps?.length) return undefined;
	return deps.map((d) => {
		// Collapse to string if no condition
		if (!d.condition) return d.component;
		return { component: d.component, condition: d.condition };
	});
}
