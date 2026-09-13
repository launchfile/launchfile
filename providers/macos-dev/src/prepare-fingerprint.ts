/**
 * Dependency fingerprinting for the source-mode `prepare` slot (D-38).
 *
 * D-38 requires prepare (`install ?? build`) to run "on demand (first launch or
 * a detected dependency change), never on every `dev`". The detection is a
 * fingerprint of the prepare inputs: the command string plus the contents of
 * every dependency manifest and lockfile in the directory the command runs in.
 * A run records its fingerprint in state; a later `up` that computes the same
 * fingerprint has nothing to install.
 *
 * Scope: files in the prepare working directory only. Dependency files nested
 * deeper (a monorepo's per-workspace manifests) do not move the fingerprint, so
 * editing one alone does not trigger a reinstall.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { lockfileNames } from "./lockfile-detect.js";

/**
 * Dependency manifests — the hand-edited half of the pair. They are read
 * alongside lockfiles so a project that commits no lockfile still gets change
 * detection, and so an edited manifest counts as a change before the install
 * that would regenerate the lockfile has run.
 */
const MANIFEST_FILES = [
	"package.json",
	"Gemfile",
	"go.mod",
	"Cargo.toml",
	"pyproject.toml",
	"Pipfile",
	"setup.py",
	"composer.json",
] as const;

/** Every file whose content is a prepare input, deduplicated and ordered. */
function dependencyFiles(): string[] {
	return [...new Set<string>([...lockfileNames(), ...MANIFEST_FILES])].sort();
}

/**
 * Fingerprint the inputs of one component's prepare run.
 *
 * The command string is part of the digest, so editing `install:`/`build:` in
 * the Launchfile re-runs prepare even when no dependency file moved. A missing
 * file contributes nothing to the digest, so creating or deleting one changes it.
 */
export async function prepareFingerprint(
	dir: string,
	command: string,
): Promise<string> {
	const hash = createHash("sha256");
	hash.update(`command ${command} `);
	for (const name of dependencyFiles()) {
		let content: Buffer;
		try {
			content = await readFile(join(dir, name));
		} catch {
			continue;
		}
		hash.update(`file ${name} `);
		hash.update(createHash("sha256").update(content).digest("hex"));
		hash.update(" ");
	}
	return hash.digest("hex").slice(0, 16);
}
