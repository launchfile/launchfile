#!/usr/bin/env bun
/**
 * Run the declared-VOLUME gate (see declared-volume-gate.ts) against the live
 * registries.
 *
 *   bun run check:volumes
 *
 * Reads each image's config with `docker buildx imagetools inspect`, which
 * fetches manifests and the config blob and pulls no layers. Needs docker
 * with the buildx plugin and network access; no credentials.
 *
 * Prints the resolved digest of every image it reads, because several tags
 * float (`:latest`, `mongo:7`) and a red run must be reproducible.
 *
 * Exit codes: 0 clean, 1 a mount or exception finding, 2 a registry read
 * that failed after every retry, or an image config it could not interpret. A failed read never
 * counts as a pass.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	backingImageCases,
	checkDeclaredVolumes,
	type DeclaredVolumes,
	declaredLinuxVolumes,
	describeFinding,
	RegistryReadError,
	withRetries,
} from "./declared-volume-gate.js";

const run = promisify(execFile);
const ATTEMPTS = 3;

const out = (line: string): void => {
	process.stdout.write(`${line}\n`);
};
const err = (line: string): void => {
	process.stderr.write(`${line}\n`);
};
const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** The digest and raw image config, straight from the registry. */
async function inspect(
	image: string,
): Promise<{ digest: string; config: unknown }> {
	const { stdout } = await run(
		"docker",
		[
			"buildx",
			"imagetools",
			"inspect",
			image,
			"--format",
			'{"digest":{{json .Manifest.Digest}},"image":{{json .Image}}}',
		],
		{ maxBuffer: 64 * 1024 * 1024 },
	);
	const parsed = JSON.parse(stdout) as { digest?: unknown; image?: unknown };
	if (typeof parsed.digest !== "string" || parsed.digest === "") {
		throw new Error("inspect returned no manifest digest");
	}
	return { digest: parsed.digest, config: parsed.image };
}

async function main(): Promise<number> {
	const cases = backingImageCases();
	const images = [...new Set(cases.map((c) => c.image))];
	out(
		`Reading declared VOLUME for ${images.length} images (${cases.length} backing services)`,
	);

	const declared = new Map<string, DeclaredVolumes>();
	const readFailures: string[] = [];
	for (const image of images) {
		try {
			const read = await withRetries(
				image,
				() => inspect(image),
				ATTEMPTS,
				sleep,
			);
			const d = {
				digest: read.digest,
				paths: declaredLinuxVolumes(image, read.config),
			};
			declared.set(image, d);
			const vols = d.paths.length > 0 ? d.paths.join(", ") : "(none)";
			out(`  ${image}@${d.digest}  VOLUME: ${vols}`);
		} catch (e) {
			const msg =
				e instanceof RegistryReadError
					? e.message
					: `could not interpret the image config: ${e instanceof Error ? e.message : String(e)}`;
			readFailures.push(msg);
			err(`::error::${msg}`);
		}
	}
	if (readFailures.length > 0) {
		err(
			`${readFailures.length} image(s) could not be read — the gate did not run and does not pass`,
		);
		return 2;
	}

	const findings = checkDeclaredVolumes(cases, declared);
	if (findings.length > 0) {
		for (const f of findings) err(`::error::${describeFinding(f)}`);
		err(`${findings.length} declared-VOLUME finding(s)`);
		return 1;
	}
	out(
		`OK: every declared VOLUME across ${cases.length} backing services is mounted or excepted`,
	);
	return 0;
}

process.exitCode = await main();
