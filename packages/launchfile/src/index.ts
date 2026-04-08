/**
 * Public API for the unified Launchfile CLI.
 *
 * Re-exports the SDK public API so `import { readLaunch } from "launchfile"` works.
 */

// SDK re-exports
export {
	readLaunch,
	validateLaunch,
	writeLaunch,
	parseExpression,
	resolveExpression,
	parseDotPath,
	isExpression,
	LaunchSchema,
	cmdValidate,
	cmdInspect,
	cmdSchema,
} from "@launchfile/sdk";
export type { ResolverContext } from "@launchfile/sdk";

// CLI exports
export { handleUp } from "./commands/up.js";
export { handleDown } from "./commands/down.js";
export { handleStatus } from "./commands/status.js";
export { handleLogs } from "./commands/logs.js";
export { handleList } from "./commands/list.js";
export {
	loadIndex,
	saveIndex,
	addDeployment,
	updateDeployment,
	removeDeployment,
	findDeployment,
	findBySource,
	generateDeploymentId,
	deploymentsDir,
	deploymentDir,
} from "./state/index.js";
export type { DeploymentEntry, DeploymentIndex } from "./state/types.js";
export { detectProvider, type ProviderName } from "./detect-provider.js";
export { resolveUpTarget, resolveDeploymentTarget } from "./resolve-target.js";
