#!/usr/bin/env node
/**
 * AWS provider CLI — implements the single verb this provider supports:
 *
 *   launchfile-aws translate <Launchfile> [--out <dir>] [--region <r>]
 *                                         [--rekey <address>]...
 *
 * Reads a Launchfile, emits `main.tf` and a `CONFORMANCE.md` report into the
 * output directory (default: ./aws-out), and prints a one-line summary. It does
 * not — and cannot — apply anything. User-facing output goes to stdout; logs to
 * stderr (logger.ts).
 *
 * `--rekey` names a minted secret, by Terraform address, that the operator is
 * deliberately re-minting under D-47; it is the step a refusal prints when the
 * record came from `main.tf`. Every other minted value is still preserved.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readLaunch } from "@launchfile/sdk";
import { type ConformanceEntry, renderConformanceReport } from "./gaps.js";
import {
	RekeyAddressError,
	readPriorStack,
	UnreadableStateError,
} from "./prior-stack.js";
import { SecretRotationError, translate } from "./translate.js";

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

/** A flag written in a form this CLI does not read. Refused, never dropped. */
class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

/**
 * Every value given to a repeatable `--<name> <value>` flag, in order. A
 * `--<name>` with no value, or the `--<name>=<value>` form, is refused: a
 * `--rekey` that is silently dropped would leave the refusal it answers in
 * place and read as if the re-key had been done.
 */
function flags(args: string[], name: string): string[] {
	const values: string[] = [];
	args.forEach((arg, i) => {
		if (arg.startsWith(`--${name}=`)) {
			throw new UsageError(
				`${arg}: write it as \`--${name} <value>\` — the \`=\` form is not read.`,
			);
		}
		if (arg !== `--${name}`) return;
		const value = args[i + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new UsageError(`--${name} needs a value: \`--${name} <value>\`.`);
		}
		values.push(value);
	});
	return values;
}

function main(): void {
	const [command, ...rest] = process.argv.slice(2);

	if (command !== "translate" || rest.length === 0 || rest[0] === undefined) {
		process.stdout.write(
			[
				"launchfile-aws — translate a Launchfile to Terraform (translation only; never applies)",
				"",
				"Usage:",
				"  launchfile-aws translate <Launchfile> [--out <dir>] [--region <region>]",
				"                                        [--rekey <random_type.name>]...",
				"",
				"  --rekey  re-mint this already-minted secret under D-47 on purpose (repeatable);",
				"           the address is the one a refusal or CONFORMANCE.md gap prints",
				"",
			].join("\n"),
		);
		process.exit(command === "translate" ? 1 : 0);
	}

	const file = rest[0];
	const outDir = resolve(flag(rest, "out") ?? "aws-out");
	const region = flag(rest, "region");
	let rekey: string[];
	try {
		rekey = flags(rest, "rekey");
	} catch (err) {
		if (err instanceof UsageError) {
			process.stderr.write(`${err.message}\nNothing was written.\n`);
			process.exit(1);
		}
		throw err;
	}

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
