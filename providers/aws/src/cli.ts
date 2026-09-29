#!/usr/bin/env node
/**
 * AWS provider CLI — implements the single verb this provider supports:
 *
 *   launchfile-aws translate <Launchfile> [--out <dir>] [--region <r>]
 *                                         [--rekey <address>]...
 *
 * Argument rules live in cli-args.ts. Reads a Launchfile, emits `main.tf` and
 * a `CONFORMANCE.md` report into the output directory (default: ./aws-out),
 * and prints a one-line summary. It does not — and cannot — apply anything.
 * User-facing output goes to stdout; refusals and logs to stderr (logger.ts).
 *
 * `--rekey` names a minted secret, by Terraform address, that the operator is
 * deliberately re-minting under D-47; it is the step a refusal prints when the
 * record came from `main.tf`. Every other minted value is still preserved.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readLaunch } from "@launchfile/sdk";
import { parseArgs } from "./cli-args.js";
import { type ConformanceEntry, renderConformanceReport } from "./gaps.js";
import {
	RekeyAddressError,
	readPriorStack,
	UnreadableStateError,
} from "./prior-stack.js";
import { SecretRotationError, translate } from "./translate.js";

const USAGE = [
	"launchfile-aws — translate a Launchfile to Terraform (translation only; never applies)",
	"",
	"Usage:",
	"  launchfile-aws translate <Launchfile> [--out <dir>] [--region <region>]",
	"                                        [--rekey <random_type.name>]...",
	"  launchfile-aws --help",
	"",
	"  --out     output directory (default: ./aws-out)",
	"  --region  AWS region for the provider block (default: us-east-1)",
	"  --rekey   re-mint this already-minted secret under D-47 on purpose (repeatable);",
	"            the address is the one a refusal or CONFORMANCE.md gap prints",
	"",
].join("\n");

function main(): void {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.kind === "help") {
		process.stdout.write(USAGE);
		return;
	}
	if (parsed.kind === "refuse") {
		// A flag or verb this CLI does not read is refused, never dropped: the
		// translation that followed would carry the default in its place (D-67).
		process.stderr.write(
			`${parsed.message}\nRun \`launchfile-aws --help\` for usage.\nNothing was written.\n`,
		);
		process.exit(1);
	}

	const { file, region, rekey } = parsed.args;
	const outDir = resolve(parsed.args.out ?? "aws-out");

	const yaml = readFileSync(resolve(file), "utf8");
	const launch = readLaunch(yaml);

	let result: ReturnType<typeof translate>;
	try {
		// What the output directory already holds decides whether a `generator:`
		// value is minted fresh or preserved. Only resource types and names are
		// read — never a value (prior-stack.ts). `--rekey` drops exactly the
		// named records; a misspelt one refuses rather than passing as done.
		const priorStack = readPriorStack(outDir, { rekey });
		result = translate(launch, {
			...(region ? { region } : {}),
			...(priorStack ? { priorStack } : {}),
		});
	} catch (err) {
		if (
			err instanceof SecretRotationError ||
			err instanceof RekeyAddressError ||
			err instanceof UnreadableStateError
		) {
			// Refuse rather than emit HCL whose apply destroys a live secret.
			process.stderr.write(`${err.message}\n`);
			process.exit(1);
		}
		throw err;
	}
	const { hcl, conformance, preservedSecrets } = result;

	mkdirSync(outDir, { recursive: true });
	writeFileSync(resolve(outDir, "main.tf"), hcl);

	const entry: ConformanceEntry = {
		name: launch.name,
		source: file,
		conformance,
	};
	writeFileSync(
		resolve(outDir, "CONFORMANCE.md"),
		renderConformanceReport([entry]),
	);

	process.stdout.write(
		`Translated ${launch.name} → ${outDir}/main.tf\n` +
			`  ${conformance.mapped.length} mapped · ${conformance.gaps.length} gap(s) · ${conformance.ignored.length} ignored\n` +
			(preservedSecrets.length > 0
				? `  ${preservedSecrets.length} secret(s) preserved from the existing stack (pre-D-47 shape kept so the deployed value survives):\n` +
					preservedSecrets.map((a) => `    ${a}\n`).join("")
				: ""),
	);
}

main();
