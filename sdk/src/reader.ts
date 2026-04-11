/**
 * Reader: YAML string → validated, normalized Launch object.
 *
 * Handles all scalar-or-object shorthands:
 *   - "postgres" → { type: "postgres" }
 *   - "." → { context: "." }
 *   - "/health" → { path: "/health" }
 *   - "backend" → { component: "backend" }
 *   - "node server.js" → { command: "node server.js" }
 *   - "8080" → { default: "8080" }
 */

import { parse } from "yaml";
import { LaunchSchema } from "./schema.js";
import type {
	Launch,
	NormalizedLaunch,
	NormalizedComponent,
	NormalizedRequirement,
	NormalizedDependsOnEntry,
	NormalizedCommand,
	NormalizedBuild,
	NormalizedHealth,
	NormalizedEnvVar,
	Build,
	Health,
	Requirement,
	Support,
	DependsOnEntry,
	Commands,
	EnvVar,
	Component,
} from "./types.js";

// Security: cap input size and YAML alias expansion to prevent
// billion-laughs DoS and memory exhaustion from untrusted input.
const MAX_YAML_SIZE = 1_048_576; // 1 MB
const MAX_ALIAS_COUNT = 100;

/** Parse and validate a YAML string into a normalized Launch object */
export function readLaunch(yaml: string): NormalizedLaunch {
	if (yaml.length > MAX_YAML_SIZE) {
		throw new Error(`Launchfile exceeds maximum size of ${MAX_YAML_SIZE} bytes`);
	}
	const raw = parse(yaml, { maxAliasCount: MAX_ALIAS_COUNT });
	const validated = LaunchSchema.parse(raw) as Launch;
	return normalizeLaunch(validated);
}

/** Validate a parsed object (already from YAML) */
export function validateLaunch(data: unknown): NormalizedLaunch {
	const validated = LaunchSchema.parse(data) as Launch;
	return normalizeLaunch(validated);
}

/** Normalize a validated Launch into its fully expanded form */
function normalizeLaunch(launch: Launch): NormalizedLaunch {
	const result: NormalizedLaunch = {
		version: launch.version,
		generator: launch.generator,
		name: launch.name,
		description: launch.description,
		secrets: launch.secrets,
		components: {},
	};

	if (launch.components && Object.keys(launch.components).length > 0) {
		// Multi-component mode
		for (const [name, component] of Object.entries(launch.components)) {
			result.components[name] = normalizeComponent(component, launch);
		}
	} else {
		// Single-component mode — create a "default" component from top-level fields
		result.components.default = normalizeComponent(extractComponentFields(launch));
	}

	return result;
}

/** Extract component-level fields from top-level Launch (single-component mode) */
function extractComponentFields(launch: Launch): Component {
	return {
		runtime: launch.runtime,
		image: launch.image,
		build: launch.build,
		provides: launch.provides,
		requires: launch.requires,
		supports: launch.supports,
		env: launch.env,
		commands: launch.commands,
		health: launch.health,
		depends_on: launch.depends_on,
		storage: launch.storage,
		restart: launch.restart,
		schedule: launch.schedule,
		singleton: launch.singleton,
		platform: launch.platform,
		host: launch.host,
	};
}

/** Normalize a component, expanding all shorthands */
function normalizeComponent(component: Component, defaults?: Launch): NormalizedComponent {
	return {
		runtime: component.runtime ?? defaults?.runtime,
		image: component.image ?? defaults?.image,
		build: normalizeBuild(component.build ?? defaults?.build),
		provides: component.provides,
		requires: normalizeRequirements(component.requires),
		supports: normalizeRequirements(component.supports),
		env: normalizeEnv(component.env),
		commands: normalizeCommands(component.commands),
		health: normalizeHealth(component.health),
		depends_on: normalizeDependsOn(component.depends_on),
		storage: component.storage,
		restart: component.restart ?? defaults?.restart,
		schedule: component.schedule,
		singleton: component.singleton,
		platform: component.platform ?? defaults?.platform,
		host: component.host ?? defaults?.host,
	};
}

// --- Normalizers for each shorthand type ---

function normalizeBuild(build: string | Build | undefined): NormalizedBuild | undefined {
	if (build === undefined) return undefined;
	if (typeof build === "string") return { context: build };
	return {
		context: build.context,
		dockerfile: build.dockerfile,
		target: build.target,
		args: build.args,
		secrets: build.secrets,
	};
}

function normalizeRequirements(
	reqs: Array<string | Requirement | Support> | undefined,
): NormalizedRequirement[] | undefined {
	if (!reqs) return undefined;
	return reqs.map((r) => {
		if (typeof r === "string") return { type: r };
		return {
			name: r.name,
			type: r.type,
			version: r.version,
			config: r.config,
			set_env: r.set_env,
		};
	});
}

function normalizeEnv(
	env: Record<string, string | number | boolean | EnvVar> | undefined,
): Record<string, NormalizedEnvVar> | undefined {
	if (!env) return undefined;
	const result: Record<string, NormalizedEnvVar> = {};
	for (const [key, val] of Object.entries(env)) {
		if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
			result[key] = { default: val };
		} else {
			result[key] = {
				default: val.default,
				description: val.description,
				label: val.label,
				required: val.required,
				generator: val.generator,
				sensitive: val.sensitive,
			};
		}
	}
	return result;
}

function normalizeCommands(
	commands: Commands | undefined,
): Record<string, NormalizedCommand> | undefined {
	if (!commands) return undefined;
	const result: Record<string, NormalizedCommand> = {};
	for (const [key, val] of Object.entries(commands)) {
		if (val === undefined) continue;
		if (typeof val === "string") {
			result[key] = { command: val };
		} else {
			result[key] = {
				command: val.command,
				timeout: val.timeout,
				capture: val.capture,
			};
		}
	}
	return result;
}

function normalizeHealth(health: string | Health | undefined): NormalizedHealth | undefined {
	if (health === undefined) return undefined;
	if (typeof health === "string") return { path: health };
	return {
		path: health.path,
		command: health.command,
		interval: health.interval,
		timeout: health.timeout,
		retries: health.retries,
		start_period: health.start_period,
	};
}

function normalizeDependsOn(
	deps: Array<string | DependsOnEntry> | undefined,
): NormalizedDependsOnEntry[] | undefined {
	if (!deps) return undefined;
	return deps.map((d) => {
		if (typeof d === "string") return { component: d };
		return { component: d.component, condition: d.condition };
	});
}
