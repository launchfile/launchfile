/**
 * macOS Dev Provider for Launchfile.
 *
 * Run apps locally on macOS with brew services for databases
 * and native runtimes for the app itself.
 */

export { launchUp, launchDown, launchStatus, launchEnv } from "./provider.js";
export type { LaunchUpOpts } from "./provider.js";
export { launchBootstrap } from "./bootstrap.js";
export type { BootstrapResult } from "./bootstrap.js";
export {
	captureProcessLogs,
	declaredEnvKeys,
	inPhase,
	isExpectedRefusal,
	launchErrorFrom,
	MACOS_PROVIDER,
	macosErrorKey,
	macosLaunchError,
	type PhaseContext,
} from "./errors.js";
export { registerSensitiveEnv, registerSuppliedEnv } from "./env-secrets.js";
export { registerDeclaredSecret, redactSecrets } from "./redact.js";
