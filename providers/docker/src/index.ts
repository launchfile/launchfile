/**
 * Public API for the Launchfile Docker provider.
 */

export {
	type AppContext,
	// `$app.*` and `$app.endpoints.<name>.*` from one derivation (D-63).
	computeAppContext,
	computeAppProperties,
	InvalidAppUrlError,
	normalizeAppUrl,
	type PublishedAddress,
	// The provider's one derivation of a published endpoint's address (#473).
	publishedAddress,
} from "./app-url.js";
export { type BootstrapResult, dockerBootstrap } from "./bootstrap.js";
export {
	type ComposeOpts,
	type ComposeResult,
	type InitOnlyDatabases,
	type InitOnlyExtensions,
	launchToCompose,
	type StorageBind,
	type UnboundOperatorVolume,
	type UnsuppliedRequiredVar,
} from "./compose-generator.js";
export { registerSensitiveEnv, registerSuppliedEnv } from "./env-secrets.js";
export {
	DOCKER_PROVIDER,
	declaredEnvKeys,
	dockerErrorKey,
	dockerLaunchError,
} from "./errors.js";
export type {
	HostCapabilityDecision,
	HostCapabilityGrant,
	HostCapabilityPolicy,
	HostCapabilityRequest,
} from "./host-capabilities.js";
// For a caller that post-processes the generated services (platform
// hardening) and must land the grants again afterwards with the same rules.
export { applyHostCapabilityGrants } from "./host-capabilities.js";
export {
	type DockerUpOpts,
	type DockerUpResult,
	dockerDown,
	dockerList,
	dockerLogs,
	dockerStatus,
	dockerUp,
	type ForeignSourceDetails,
	ForeignSourceError,
	HEALTH_TIMEOUT_MS,
	MissingOperatorStoragePathError,
	UnboundOperatorStorageError,
	UnsuppliedRequiredEnvError,
} from "./provider.js";
// Redaction is exported so a caller running IN THIS PROCESS (the unified CLI's
// bootstrap path) can scrub against the live registry. A separate process gets
// an empty registry and can scrub nothing — capture there is already too late.
export {
	redactSecrets,
	registerDeclaredSecret,
	registerSecret,
	registerSecrets,
} from "./redact.js";
// The one refusal set (PROVIDERS.md §10 item 5): what the compose generator
// emits nothing for and what empties a refused primary's `$app.*` (D-72).
export {
	type RefusalInputs,
	refusedComponents,
	type SuppliedResources,
} from "./refusals.js";
export { type ResolvedSource, resolveSource } from "./source-resolver.js";
export {
	type DockerSourceInfo,
	type DockerSourceType,
	InvalidInstanceLabelError,
	instanceSlug,
	loadDockerSource,
} from "./state.js";
