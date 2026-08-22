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
	HostCapability,
	DependsOnEntry,
	Commands,
	EnvVar,
	Component,
} from "./types.js";

// Security: cap input size and YAML alias expansion to prevent
// billion-laughs DoS and memory exhaustion from untrusted input.
const MAX_YAML_SIZE = 1_048_576; // 1 MB
const MAX_ALIAS_COUNT = 100;

// D-44: unknown fields are preserved, never stripped. The normalizers below
// spread the source object before overwriting known fields, so unknown keys
// ride through normalization and reach the writer. At the top level the
// component-shorthand fields fold into the "default" component, so unknown
// top-level keys are picked out explicitly and kept at the top level.

/** Component-level fields the normalizer consumes (shared by top level as shorthand) */
const COMPONENT_FIELD_KEYS = [
	"runtime", "image", "build", "source", "provides", "requires", "supports",
	"env", "commands", "health", "depends_on", "storage", "restart",
	"schedule", "singleton", "platform", "host",
] as const;

/** Top-level fields the normalizer consumes */
const TOP_LEVEL_FIELD_KEYS: ReadonlySet<string> = new Set([
	"version", "generator", "name", "description", "secrets", "components",
	...COMPONENT_FIELD_KEYS,
]);

/** Pick the fields of `obj` that are not in `known` (unknown fields, D-44) */
function unknownFields(obj: object, known: ReadonlySet<string>): Record<string, unknown> {
	const extras: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (!known.has(key) && value !== undefined) extras[key] = value;
	}
	return extras;
}

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
		...unknownFields(launch, TOP_LEVEL_FIELD_KEYS),
		version: launch.version,
		generator: launch.generator,
		name: launch.name,
		description: launch.description,
		repository: launch.repository,
		website: launch.website,
		logo: launch.logo,
		keywords: launch.keywords,
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
		source: launch.source,
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

/** Normalize a component, expanding all shorthands (unknown fields ride through via spread, D-44) */
function normalizeComponent(component: Component, defaults?: Launch): NormalizedComponent {
	return {
		...component,
		runtime: component.runtime ?? defaults?.runtime,
		image: component.image ?? defaults?.image,
		build: normalizeBuild(component.build ?? defaults?.build),
		source: component.source ?? defaults?.source,
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
	return { ...build };
}

function normalizeRequirements(
	reqs: Array<string | Requirement | Support | HostCapability> | undefined,
): NormalizedRequirement[] | undefined {
	if (!reqs) return undefined;
	return reqs.map((r) => {
		if (typeof r === "string") return { type: r };
		if ("host" in r) {
			// Host-capability entry (D-44): the `host:` marker is the kind
			// discriminator; `type` is synthesized as "host" so consumers that
			// key on type keep working. The `host` field stays authoritative.
			// The spread carries unknown fields through (D-45).
			return { ...r, type: "host" };
		}
		return { ...r };
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
			result[key] = { ...val };
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
			result[key] = { ...val };
		}
	}
	return result;
}

function normalizeHealth(health: string | Health | undefined): NormalizedHealth | undefined {
	if (health === undefined) return undefined;
	if (typeof health === "string") return { path: health };
	return { ...health };
}

function normalizeDependsOn(
	deps: Array<string | DependsOnEntry> | undefined,
): NormalizedDependsOnEntry[] | undefined {
	if (!deps) return undefined;
	return deps.map((d) => {
		if (typeof d === "string") return { component: d };
		return { ...d };
	});
}
