/**
 * `launchfile list` — Show all managed deployments.
 */

import { loadIndex } from "../state/index.js";

export async function handleList(): Promise<void> {
	const index = await loadIndex();
	const entries = Object.entries(index.deployments);

	if (entries.length === 0) {
		console.log("No managed deployments.");
		console.log("Run `launchfile up <slug>` to start one. Example: launchfile up ghost");
		return;
	}

	// Print table header
	const idW = 9;
	const appW = 16;
	const provW = 8;
	const portW = 6;
	const statusW = 8;

	console.log(
		`${"ID".padEnd(idW)}${"APP".padEnd(appW)}${"PROVIDER".padEnd(provW)}${"PORT".padEnd(portW)}${"STATUS".padEnd(statusW)}SOURCE`,
	);

	for (const [id, entry] of entries) {
		const source = entry.sourceType === "local"
			? entry.source.replace(process.env.HOME ?? "", "~")
			: entry.source;
		const port = entry.port ? String(entry.port) : "—";
		const name = entry.name ? ` (${entry.name})` : "";

		console.log(
			`${id.padEnd(idW)}${(entry.appName + name).padEnd(appW)}${entry.provider.padEnd(provW)}${port.padEnd(portW)}${entry.status.padEnd(statusW)}${source}`,
		);
	}
}
