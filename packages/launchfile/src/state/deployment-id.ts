/**
 * Generate short deployment IDs (7-char hex).
 *
 * Enough entropy for a single user's deployments (~16M possibilities).
 * Short enough to type in `launchfile down a3f2b1c`.
 */

import { randomBytes } from "node:crypto";

export function generateDeploymentId(): string {
	return randomBytes(4).toString("hex").slice(0, 7);
}
