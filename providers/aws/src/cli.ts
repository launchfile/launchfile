#!/usr/bin/env node
/**
 * AWS provider CLI — implements the single verb this provider supports:
 *
 *   launchfile-aws translate <Launchfile> [--out <dir>] [--region <r>]
 *
 * Reads a Launchfile, emits `main.tf` and a `CONFORMANCE.md` report into the
 * output directory (default: ./aws-out), and prints a one-line summary. It does
 * not — and cannot — apply anything. User-facing output goes to stdout; logs to
 * stderr (logger.ts).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readLaunch } from "@launchfile/sdk";
import { type ConformanceEntry, renderConformanceReport } from "./gaps.js";
import { readPriorStack } from "./prior-stack.js";
import { SecretRotationError, translate } from "./translate.js";

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
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
				"",
			].join("\n"),
		);
		process.exit(command === "translate" ? 1 : 0);
	}

	const file = rest[0];
	const outDir = resolve(flag(rest, "out") ?? "aws-out");
	const region = flag(rest, "region");

	const yaml = readFileSync(resolve(file), "utf8");
	const launch = readLaunch(yaml);

	// What the output directory already holds decides whether a `generator:`
	// value is minted fresh or preserved. Only resource types and names are
	// read — never a value (prior-stack.ts).
	const priorStack = readPriorStack(outDir);

	let result: ReturnType<typeof translate>;
	try {
		result = translate(launch, {
			...(region ? { region } : {}),
			...(priorStack ? { priorStack } : {}),
		});
	} catch (err) {
		if (err instanceof SecretRotationError) {
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
