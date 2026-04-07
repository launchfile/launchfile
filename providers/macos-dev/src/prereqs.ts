/**
 * Prerequisite checks for the macOS dev provider.
 */

import { shellOk } from "./shell.js";

export interface PrereqResult {
	ok: boolean;
	missing: string[];
	warnings: string[];
}

export async function checkPrereqs(): Promise<PrereqResult> {
	const missing: string[] = [];
	const warnings: string[] = [];

	// Homebrew is required
	if (!(await shellOk("which brew"))) {
		missing.push("Homebrew — install from https://brew.sh");
	}

	// Git is required (for cloning)
	if (!(await shellOk("which git"))) {
		missing.push("git — install via: brew install git");
	}

	return {
		ok: missing.length === 0,
		missing,
		warnings,
	};
}
