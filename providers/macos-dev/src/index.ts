/**
 * macOS Dev Provider for Launchfile.
 *
 * Run apps locally on macOS with brew services for databases
 * and native runtimes for the app itself.
 */

export { launchUp, launchDown, launchStatus, launchEnv } from "./provider.js";
export type { LaunchUpOpts } from "./provider.js";
export { launchBootstrap } from "./bootstrap.js";
// Re-exported so a caller of this provider catches the publication-URL refusal
// (D-58 rule 3) without also depending on the SDK, matching
// `@launchfile/docker`. The SDK owns both.
export { InvalidAppUrlError, normalizeAppUrl } from "@launchfile/sdk";
export type { BootstrapResult } from "./bootstrap.js";
