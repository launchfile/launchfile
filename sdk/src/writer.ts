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

// D-45: unknown fields are preserved, never stripped. Each denormalizer
// re-emits the fields it does not recognize, and an object holding unknown
// fields never collapses to its scalar shorthand (collapsing would drop them).

const LAUNCH_FIELD_KEYS: ReadonlySet<string> = new Set([
	"version", "generator", "name", "description", "secrets", "components",
]);
const COMPONENT_FIELD_KEYS: ReadonlySet<string> = new Set([
	"runtime", "image", "build", "source", "provides", "requires", "supports",
	"env", "commands", "health", "depends_on", "storage", "restart",
	"schedule", "singleton", "platform", "host",
]);
const BUILD_FIELD_KEYS: ReadonlySet<string> = new Set([
	"context", "dockerfile", "target", "args", "secrets",
]);
const REQUIREMENT_FIELD_KEYS: ReadonlySet<string> = new Set([
	"name", "type", "version", "config", "set_env",
]);
const ENV_VAR_FIELD_KEYS: ReadonlySet<string> = new Set([
	"default", "description", "label", "required", "generator", "sensitive",
]);
const COMMAND_FIELD_KEYS: ReadonlySet<string> = new Set(["command", "timeout", "capture"]);
const HEALTH_FIELD_KEYS: ReadonlySet<string> = new Set([
	"path", "command", "interval", "timeout", "retries", "start_period",
]);
const DEPENDS_ON_FIELD_KEYS: ReadonlySet<string> = new Set(["component", "condition"]);

/** Pick the fields of `obj` that are not in `known` (unknown fields, D-45) */
function unknownFields(obj: object, known: ReadonlySet<string>): Record<string, unknown> {
	const extras: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (!known.has(key) && value !== undefined) extras[key] = value;
	}
	return extras;
}

function hasUnknownFields(obj: object, known: ReadonlySet<string>): boolean {
	return Object.keys(unknownFields(obj, known)).length > 0;
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
	if (launch.repository) result.repository = launch.repository;
	if (launch.website) result.website = launch.website;
	if (launch.logo) result.logo = launch.logo;
	if (launch.keywords && launch.keywords.length > 0) result.keywords = launch.keywords;
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

	Object.assign(result, unknownFields(launch, LAUNCH_FIELD_KEYS));

	return result;
}

/** Denormalize a component, collapsing to shorthands where possible */
function denormalizeComponent(comp: NormalizedComponent): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	if (comp.runtime) result.runtime = comp.runtime;
	if (comp.image) result.image = comp.image;

	const build = denormalizeBuild(comp.build);
	if (build !== undefined) result.build = build;
	if (comp.source) result.source = comp.source;

	if (comp.provides?.length) result.provides = comp.provides;

	const requires = denormalizeRequirements(comp.requires);
	if (requires?.length) result.requires = requires;

	const supports = denormalizeRequirements(comp.supports);
	if (supports?.length) result.supports = supports;

	const env = denormalizeEnv(comp.env);
	if (env && Object.keys(env).length > 0) result.env = env;

	const commands = denormalizeCommands(comp.commands);
	if (commands && Object.keys(commands).length > 0) result.commands = commands;

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

	Object.assign(result, unknownFields(comp, COMPONENT_FIELD_KEYS));

	return result;
}

// --- Shorthand collapsers ---

function denormalizeBuild(build: NormalizedBuild | undefined): string | Record<string, unknown> | undefined {
	if (!build) return undefined;
	// Collapse to string if only context is set
	if (
		build.context &&
		!build.dockerfile &&
		!build.target &&
		!build.args &&
		!build.secrets &&
		!hasUnknownFields(build, BUILD_FIELD_KEYS)
	) {
		return build.context;
	}
	const result: Record<string, unknown> = {};
	if (build.context) result.context = build.context;
	if (build.dockerfile) result.dockerfile = build.dockerfile;
	if (build.target) result.target = build.target;
	if (build.args) result.args = build.args;
	if (build.secrets) result.secrets = build.secrets;
	Object.assign(result, unknownFields(build, BUILD_FIELD_KEYS));
	return result;
}

function denormalizeRequirements(
	reqs: NormalizedRequirement[] | undefined,
): Array<string | Record<string, unknown>> | undefined {
	if (!reqs?.length) return undefined;
	return reqs.map((r) => {
		// Host-capability entry (D-44): serialize with the `host:` marker,
		// never the synthetic `type: "host"` the normalizer added.
		if (r.host) {
			const capability: Record<string, unknown> = { host: r.host };
			if (r.set_env) capability.set_env = r.set_env;
			return capability;
		}
		// Collapse to string if only type is set
		if (!r.name && !r.version && !r.config && !r.set_env && !hasUnknownFields(r, REQUIREMENT_FIELD_KEYS)) {
			return r.type;
		}
		const result: Record<string, unknown> = {};
		if (r.name) result.name = r.name;
		result.type = r.type;
		if (r.version) result.version = r.version;
		if (r.config) result.config = r.config;
		if (r.set_env) result.set_env = r.set_env;
		Object.assign(result, unknownFields(r, REQUIREMENT_FIELD_KEYS));
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
			!val.sensitive &&
			!hasUnknownFields(val, ENV_VAR_FIELD_KEYS)
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
			Object.assign(obj, unknownFields(val, ENV_VAR_FIELD_KEYS));
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
		const hasCapture = val.capture && Object.keys(val.capture).length > 0;
		// Collapse to string shorthand only if there are no fields beyond command
		if (!val.timeout && !hasCapture && !hasUnknownFields(val, COMMAND_FIELD_KEYS)) {
			result[key] = val.command;
		} else {
			const expanded: Record<string, unknown> = { command: val.command };
			if (val.timeout) expanded.timeout = val.timeout;
			if (hasCapture) expanded.capture = val.capture;
			Object.assign(expanded, unknownFields(val, COMMAND_FIELD_KEYS));
			result[key] = expanded;
		}
	}
	return result;
}

function denormalizeHealth(health: NormalizedHealth | undefined): string | Record<string, unknown> | undefined {
	if (!health) return undefined;
	// Collapse to string if only path is set
	if (
		health.path &&
		!health.command &&
		!health.interval &&
		!health.timeout &&
		!health.retries &&
		!health.start_period &&
		!hasUnknownFields(health, HEALTH_FIELD_KEYS)
	) {
		return health.path;
	}
	const result: Record<string, unknown> = {};
	if (health.path) result.path = health.path;
	if (health.command) result.command = health.command;
	if (health.interval) result.interval = health.interval;
	if (health.timeout) result.timeout = health.timeout;
	if (health.retries) result.retries = health.retries;
	if (health.start_period) result.start_period = health.start_period;
	Object.assign(result, unknownFields(health, HEALTH_FIELD_KEYS));
	return result;
}

function denormalizeDependsOn(
	deps: NormalizedDependsOnEntry[] | undefined,
): Array<string | Record<string, unknown>> | undefined {
	if (!deps?.length) return undefined;
	return deps.map((d) => {
		// Collapse to string if no condition
		if (!d.condition && !hasUnknownFields(d, DEPENDS_ON_FIELD_KEYS)) return d.component;
		return { component: d.component, condition: d.condition, ...unknownFields(d, DEPENDS_ON_FIELD_KEYS) };
	});
}
