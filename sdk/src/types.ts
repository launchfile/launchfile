/**
 * Launchfile — Universal App Descriptor
 *
 * Type definitions for the Launchfile format.
 * See spec/SPEC.md for the full specification.
 */

// --- Enums / Unions ---

/** Supported runtime identifiers */
export type Runtime =
	| "node"
	| "bun"
	| "deno"
	| "python"
	| "ruby"
	| "go"
	| "rust"
	| "java"
	| "php"
	| "elixir"
	| "csharp"
	| "static";

/** Supported resource types for requires/supports */
export type ResourceType =
	| "postgres"
	| "mysql"
	| "sqlite"
	| "mongodb"
	| "redis"
	| "memcache"
	| "rabbitmq"
	| "elasticsearch"
	| "minio"
	| "s3"
	| (string & {}); // allow unknown types with autocomplete for known ones

/** Network protocol a component exposes */
export type Protocol = "http" | "https" | "tcp" | "udp" | "grpc" | "ws";

/** How to auto-generate a value */
export type Generator = "secret" | "uuid" | "port";

/** Restart policy */
export type RestartPolicy = "always" | "on-failure" | "no";

/** Health check condition for depends_on */
export type DependsOnCondition = "started" | "healthy";

// --- Secrets ---

/** An app-wide generated secret, shared across components via $secrets.name */
export interface Secret {
	/** How to generate the value */
	generator: Generator;
	/** Human description */
	description?: string;
}

// --- Provides ---

/** What a component exposes to the network */
export interface Provides {
	/** Optional name for referencing this endpoint (e.g., "api", "metrics") */
	name?: string;
	/** Network protocol */
	protocol: Protocol;
	/** Container port */
	port: number;
	/** Bind address (default: "0.0.0.0") */
	bind?: string;
	/** Whether this port is reachable from outside the host */
	exposed?: boolean;
	/** API spec references */
	spec?: Record<string, string>;
}

// --- Requires / Supports ---

/** A resource dependency with env var wiring */
export interface Requirement {
	/** Resource name for expression references (defaults to type) */
	name?: string;
	/** Resource type (e.g., "postgres", "redis") */
	type: ResourceType;
	/** Version constraint (semver ranges, e.g., ">=15", "^7.0") */
	version?: string;
	/** Resource provisioning hints (platform-interpreted) */
	config?: Record<string, unknown>;
	/** Maps resource properties to app env vars. Values use $ syntax. */
	set_env?: Record<string, string>;
}

/** An optional resource that enhances the app when available */
export interface Support {
	/** Resource name for expression references (defaults to type) */
	name?: string;
	/** Resource type */
	type: ResourceType;
	/** Version constraint */
	version?: string;
	/** Resource provisioning hints (platform-interpreted) */
	config?: Record<string, unknown>;
	/** Maps resource properties to app env vars (only set when resource is available) */
	set_env?: Record<string, string>;
}

// --- Environment Variables ---

/** Full env var definition */
export interface EnvVar {
	/** Default value */
	default?: string | number | boolean;
	/** Human description (supports markdown) */
	description?: string;
	/** Short label for CLI prompts */
	label?: string;
	/** Whether the app cannot start without this value */
	required?: boolean;
	/** Auto-generate the value */
	generator?: Generator;
	/** Whether this value should be stored in a secrets manager */
	sensitive?: boolean;
}

// --- Build ---

/** Build configuration */
export interface Build {
	/** Build context directory (relative to repo root) */
	context?: string;
	/** Path to Dockerfile */
	dockerfile?: string;
	/** Multi-stage build target */
	target?: string;
	/** Build arguments */
	args?: Record<string, string>;
	/** Secrets available during build (never baked into image) */
	secrets?: string[];
}

// --- Health ---

/** Health check configuration */
export interface Health {
	/** HTTP path to check */
	path?: string;
	/** Command to run for non-HTTP checks */
	command?: string;
	/** Check interval (e.g., "30s", "1m") */
	interval?: string;
	/** Timeout per check attempt */
	timeout?: string;
	/** Consecutive failures before unhealthy */
	retries?: number;
	/** Grace period before failures count (for slow-starting apps) */
	start_period?: string;
}

// --- Commands ---

/** Lifecycle commands */
export interface Commands {
	/** Build stage — install deps, compile */
	build?: string | CommandDetail;
	/** Release stage — migrations, cache clear, asset compilation */
	release?: string | CommandDetail;
	/** Run stage — start the application */
	start?: string | CommandDetail;
	/** Seed the database with initial data */
	seed?: string | CommandDetail;
	/** Run the test suite */
	test?: string | CommandDetail;
	/** Additional named commands */
	[key: string]: string | CommandDetail | undefined;
}

/** Expanded command with options */
export interface CommandDetail {
	/** The command string */
	command: string;
	/** Timeout for command execution */
	timeout?: string;
}

// --- Output ---

/** Named output captured from release command stdout */
export interface Output {
	/** Regex with one capture group, matched against release command stdout */
	pattern: string;
	/** Human-readable description */
	description?: string;
	/** If true, value is masked in API/UI unless explicitly revealed */
	sensitive?: boolean;
}

// --- Host ---

/** Host-level capabilities the app requires beyond a standard container */
export interface Host {
	/** Whether the app needs Docker daemon access on the host */
	docker?: "required" | "optional";
	/** Network mode (default: "bridge") */
	network?: "host" | "bridge";
	/** Host filesystem access level (default: "none") */
	filesystem?: "read-write" | "read-only" | "none";
	/** Requires elevated privileges (default: false) */
	privileged?: boolean;
}

// --- Storage ---

/** Persistent storage declaration */
export interface StorageVolume {
	/** Mount path inside the container */
	path: string;
	/** Whether data should survive restarts */
	persistent?: boolean;
}

// --- Depends On ---

/** Expanded depends_on entry with health condition */
export interface DependsOnEntry {
	/** Component name */
	component: string;
	/** Condition to wait for */
	condition?: DependsOnCondition;
}

// --- Component ---

/**
 * A single component (service/process) within the app.
 * Multi-component apps have multiple of these.
 */
export interface Component {
	/** Runtime for this component */
	runtime?: Runtime;
	/** Pre-built image (alternative to build) */
	image?: string;
	/** Build configuration */
	build?: string | Build;
	/** What this component exposes */
	provides?: Provides[];
	/** Required resource dependencies */
	requires?: Array<string | Requirement>;
	/** Optional resource enhancements */
	supports?: Array<string | Support>;
	/** App-owned environment variables */
	env?: Record<string, string | EnvVar>;
	/** Lifecycle commands */
	commands?: Commands;
	/** Named outputs captured from release command stdout */
	outputs?: Record<string, Output>;
	/** Health check */
	health?: string | Health;
	/** Startup ordering */
	depends_on?: Array<string | DependsOnEntry>;
	/** Persistent storage */
	storage?: Record<string, StorageVolume>;
	/** Restart policy */
	restart?: RestartPolicy;
	/** Cron schedule (for scheduled jobs) */
	schedule?: string;
	/** Cannot be horizontally scaled */
	singleton?: boolean;
	/** OCI platform constraint (string or array) */
	platform?: string | string[];
	/** Host-level capabilities */
	host?: Host;
}

// --- Top-Level Launch ---

/**
 * The top-level Launchfile structure.
 *
 * Supports two modes:
 * 1. Single-component: fields at top level (runtime, provides, requires, etc.)
 * 2. Multi-component: using the `components` map
 *
 * Top-level fields serve as defaults when `components` is also present.
 */
export interface Launch {
	/** Spec version (e.g., "launch/v1") */
	version?: string;
	/** Tool that generated this file */
	generator?: string;
	/** App name (kebab-case, used as subdomain) */
	name: string;
	/** Brief description */
	description?: string;

	// --- App-wide secrets (shared across components) ---
	/** Named secrets generated once and referenced via $secrets.name */
	secrets?: Record<string, Secret>;

	// --- Single-component shorthand (also defaults for multi-component) ---
	runtime?: Runtime;
	image?: string;
	build?: string | Build;
	provides?: Provides[];
	requires?: Array<string | Requirement>;
	supports?: Array<string | Support>;
	env?: Record<string, string | EnvVar>;
	commands?: Commands;
	outputs?: Record<string, Output>;
	health?: string | Health;
	depends_on?: Array<string | DependsOnEntry>;
	storage?: Record<string, StorageVolume>;
	restart?: RestartPolicy;
	schedule?: string;
	singleton?: boolean;
	platform?: string | string[];
	host?: Host;

	// --- Multi-component ---
	components?: Record<string, Component>;
}

// --- Normalized Types (reader output) ---

/** Fully expanded env var (no string shorthand) */
export interface NormalizedEnvVar {
	default?: string | number | boolean;
	description?: string;
	label?: string;
	required?: boolean;
	generator?: Generator;
	sensitive?: boolean;
}

/** Fully expanded requirement (no string shorthand) */
export interface NormalizedRequirement {
	name?: string;
	type: ResourceType;
	version?: string;
	config?: Record<string, unknown>;
	set_env?: Record<string, string>;
}

/** Fully expanded depends_on entry */
export interface NormalizedDependsOnEntry {
	component: string;
	condition?: DependsOnCondition;
}

/** Fully expanded command */
export interface NormalizedCommand {
	command: string;
	timeout?: string;
}

/** Fully expanded build */
export interface NormalizedBuild {
	context?: string;
	dockerfile?: string;
	target?: string;
	args?: Record<string, string>;
	secrets?: string[];
}

/** Fully expanded health */
export interface NormalizedHealth {
	path?: string;
	command?: string;
	interval?: string;
	timeout?: string;
	retries?: number;
	start_period?: string;
}

/** A component with all shorthands expanded */
export interface NormalizedComponent {
	runtime?: Runtime;
	image?: string;
	build?: NormalizedBuild;
	provides?: Provides[];
	requires?: NormalizedRequirement[];
	supports?: NormalizedRequirement[];
	env?: Record<string, NormalizedEnvVar>;
	commands?: Record<string, NormalizedCommand>;
	outputs?: Record<string, Output>;
	health?: NormalizedHealth;
	depends_on?: NormalizedDependsOnEntry[];
	storage?: Record<string, StorageVolume>;
	restart?: RestartPolicy;
	schedule?: string;
	singleton?: boolean;
	platform?: string | string[];
	host?: Host;
}

/** Fully normalized launch descriptor — all shorthands expanded */
export interface NormalizedLaunch {
	version?: string;
	generator?: string;
	name: string;
	description?: string;
	/** App-wide secrets shared across components */
	secrets?: Record<string, Secret>;
	/** All components (single-component apps are normalized to a "default" component) */
	components: Record<string, NormalizedComponent>;
}
