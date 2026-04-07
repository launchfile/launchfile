/**
 * Public API for the unified Launchfile CLI.
 */

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
