/**
 * Public API for the Launchfile Docker provider.
 */

export {
	dockerUp,
	dockerDown,
	dockerStatus,
	dockerLogs,
	dockerList,
	HEALTH_TIMEOUT_MS,
	UnsuppliedRequiredEnvError,
	ForeignSourceError,
	type ForeignSourceDetails,
	UnboundOperatorStorageError,
	MissingOperatorStoragePathError,
	type DockerUpOpts,
	type DockerUpResult,
} from "./provider.js";
export {
	declaredEnvKeys,
	DOCKER_PROVIDER,
	dockerErrorKey,
	dockerLaunchError,
} from "./errors.js";
export { registerSensitiveEnv, registerSuppliedEnv } from "./env-secrets.js";
// Redaction is exported so a caller running IN THIS PROCESS (the unified CLI's
// bootstrap path) can scrub against the live registry. A separate process gets
// an empty registry and can scrub nothing — capture there is already too late.
export { redactSecrets, registerDeclaredSecret, registerSecret, registerSecrets } from "./redact.js";
export {
	launchToCompose,
	type ComposeResult,
	type ComposeOpts,
	type StorageBind,
	type UnboundOperatorVolume,
	type UnsuppliedRequiredVar,
} from "./compose-generator.js";
export { resolveSource, type ResolvedSource } from "./source-resolver.js";
export { dockerBootstrap, type BootstrapResult } from "./bootstrap.js";
export {
	instanceSlug,
	InvalidInstanceLabelError,
	loadDockerSource,
	type DockerSourceInfo,
	type DockerSourceType,
} from "./state.js";
