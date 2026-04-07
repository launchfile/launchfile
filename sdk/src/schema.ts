/**
 * Zod validation schemas for the Launchfile format
 *
 * Handles both shorthand (scalar) and full (object) forms.
 * Use `LaunchSchema` to validate raw YAML-parsed input.
 */

import { z } from "zod";

// --- Name constraint: letters, digits, hyphens; starts with letter ---
const namePattern = /^[a-z][a-z0-9-]*$/;
const NameSchema = z.string().max(63).regex(namePattern, "Names must match ^[a-z][a-z0-9-]*$");

// --- Scalar enums ---

const RuntimeSchema = z.enum([
	"node", "bun", "deno", "python", "ruby", "go",
	"rust", "java", "php", "elixir", "csharp", "static",
]);

const ProtocolSchema = z.enum(["http", "https", "tcp", "udp", "grpc", "ws"]);

const GeneratorSchema = z.enum(["secret", "uuid", "port"]);

const RestartPolicySchema = z.enum(["always", "on-failure", "no"]);

const DependsOnConditionSchema = z.enum(["started", "healthy"]);

// --- Secrets ---

const SecretSchema = z.object({
	generator: GeneratorSchema,
	description: z.string().max(1024).optional(),
});

// --- Provides ---

const ProvidesSchema = z.object({
	name: NameSchema.optional(),
	protocol: ProtocolSchema,
	port: z.number().int().min(1).max(65535),
	bind: z.string().optional(),
	exposed: z.boolean().optional(),
	spec: z.record(z.string(), z.string()).optional(),
});

// --- Requirement (full form) ---

const RequirementObjectSchema = z.object({
	name: NameSchema.optional(),
	type: z.string().min(1).max(256),
	version: z.string().max(256).optional(),
	// Security: config is intentionally unconstrained — providers MUST validate/sanitize
	// these values before using them in shell commands, SQL, or other injectable contexts.
	config: z.record(z.string(), z.unknown()).optional(),
	set_env: z.record(z.string(), z.string()).optional(),
});

/** Accepts string shorthand ("postgres") or full object */
const RequirementSchema = z.union([
	z.string().min(1),
	RequirementObjectSchema,
]);

// --- Support (same shape as Requirement) ---

const SupportObjectSchema = RequirementObjectSchema;
const SupportSchema = RequirementSchema;

// --- EnvVar ---

const EnvVarObjectSchema = z.object({
	default: z.union([z.string(), z.number(), z.boolean()]).optional(),
	description: z.string().max(1024).optional(),
	label: z.string().max(256).optional(),
	required: z.boolean().optional(),
	generator: GeneratorSchema.optional(),
	sensitive: z.boolean().optional(),
});

/** Accepts string shorthand ("8080") or full object */
const EnvVarSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	EnvVarObjectSchema,
]);

// --- Build ---

const BuildObjectSchema = z.object({
	context: z.string().max(1024).optional(),
	dockerfile: z.string().max(1024).optional(),
	target: z.string().max(256).optional(),
	args: z.record(z.string(), z.string()).optional(),
	secrets: z.array(z.string()).optional(),
});

/** Accepts string shorthand (".") or full object */
const BuildSchema = z.union([z.string(), BuildObjectSchema]);

// --- Health ---

const HealthObjectSchema = z.object({
	path: z.string().max(1024).optional(),
	command: z.string().max(10240).optional(),
	interval: z.string().max(64).optional(),
	timeout: z.string().max(64).optional(),
	retries: z.number().int().min(1).optional(),
	start_period: z.string().max(64).optional(),
});

/** Accepts string shorthand ("/health") or full object */
const HealthSchema = z.union([z.string(), HealthObjectSchema]);

// --- Commands ---

const CommandDetailSchema = z.object({
	command: z.string().max(10240),
	timeout: z.string().max(64).optional(),
});

/** Accepts string shorthand ("node server.js") or object with timeout */
const CommandValueSchema = z.union([z.string().max(10240), CommandDetailSchema]);

const CommandsSchema = z.record(z.string(), CommandValueSchema);

// --- Storage ---

const StorageVolumeSchema = z.object({
	path: z.string().max(1024),
	persistent: z.boolean().optional(),
});

// --- DependsOn ---

const DependsOnEntryObjectSchema = z.object({
	component: z.string().min(1),
	condition: DependsOnConditionSchema.optional(),
});

/** Accepts string shorthand ("backend") or object with condition */
const DependsOnEntrySchema = z.union([
	z.string().min(1),
	DependsOnEntryObjectSchema,
]);

// --- Output ---

const OutputSchema = z.object({
	// Security: validate that patterns compile as RegExp to catch errors early,
	// and cap length to limit ReDoS attack surface.
	pattern: z.string().max(1024).refine((p) => {
		try { new RegExp(p); return true; } catch { return false; }
	}, "Invalid regex pattern"),
	description: z.string().max(1024).optional(),
	sensitive: z.boolean().optional(),
});

// --- Host ---

const HostSchema = z.object({
	docker: z.enum(["required", "optional"]).optional(),
	network: z.enum(["host", "bridge"]).optional(),
	filesystem: z.enum(["read-write", "read-only", "none"]).optional(),
	privileged: z.boolean().optional(),
});

// --- Platform (string or array of strings) ---

const PlatformSchema = z.union([z.string(), z.array(z.string())]);

// --- Component ---

const ComponentSchema = z.object({
	runtime: RuntimeSchema.optional(),
	image: z.string().max(1024).optional(),
	build: BuildSchema.optional(),
	provides: z.array(ProvidesSchema).optional(),
	requires: z.array(RequirementSchema).optional(),
	supports: z.array(SupportSchema).optional(),
	env: z.record(z.string(), EnvVarSchema).optional(),
	commands: CommandsSchema.optional(),
	outputs: z.record(z.string(), OutputSchema).optional(),
	health: HealthSchema.optional(),
	depends_on: z.array(DependsOnEntrySchema).optional(),
	storage: z.record(z.string(), StorageVolumeSchema).optional(),
	restart: RestartPolicySchema.optional(),
	schedule: z.string().optional(),
	singleton: z.boolean().optional(),
	platform: PlatformSchema.optional(),
	host: HostSchema.optional(),
});

// --- Top-Level Launch ---

export const LaunchSchema = z.object({
	version: z.string().max(64).optional(),
	generator: z.string().max(256).optional(),
	name: NameSchema,
	description: z.string().max(4096).optional(),

	// App-wide secrets
	secrets: z.record(z.string(), SecretSchema).optional(),

	// Single-component shorthand fields
	runtime: RuntimeSchema.optional(),
	image: z.string().max(1024).optional(),
	build: BuildSchema.optional(),
	provides: z.array(ProvidesSchema).optional(),
	requires: z.array(RequirementSchema).optional(),
	supports: z.array(SupportSchema).optional(),
	env: z.record(z.string(), EnvVarSchema).optional(),
	commands: CommandsSchema.optional(),
	outputs: z.record(z.string(), OutputSchema).optional(),
	health: HealthSchema.optional(),
	depends_on: z.array(DependsOnEntrySchema).optional(),
	storage: z.record(z.string(), StorageVolumeSchema).optional(),
	restart: RestartPolicySchema.optional(),
	schedule: z.string().optional(),
	singleton: z.boolean().optional(),
	platform: PlatformSchema.optional(),
	host: HostSchema.optional(),

	// Multi-component
	components: z.record(z.string(), ComponentSchema).optional(),
});

// --- Exported sub-schemas for testing ---

export {
	NameSchema,
	RuntimeSchema,
	SecretSchema,
	ProtocolSchema,
	GeneratorSchema,
	RestartPolicySchema,
	ProvidesSchema,
	RequirementObjectSchema,
	RequirementSchema,
	SupportSchema,
	EnvVarObjectSchema,
	EnvVarSchema,
	BuildObjectSchema,
	BuildSchema,
	HealthObjectSchema,
	HealthSchema,
	CommandDetailSchema,
	CommandValueSchema,
	CommandsSchema,
	OutputSchema,
	HostSchema,
	PlatformSchema,
	StorageVolumeSchema,
	DependsOnEntrySchema,
	DependsOnEntryObjectSchema,
	ComponentSchema,
};
