#!/usr/bin/env bun
/**
 * Translate every spec example + catalog app and run `terraform validate` on the
 * emitted HCL against the real AWS provider schema. This is the conformance
 * probe's correctness gate: unit tests assert *structure*, this asserts the
 * output is *valid Terraform*.
 *
 *   bun run validate:tf            # spec examples + every catalog app (thorough)
 *   bun run validate:tf --examples # spec examples only (the stable CI gate)
 *   TERRAFORM_BIN=tofu bun run validate:tf
 *
 * Works with `terraform` (default) or OpenTofu (`tofu`). No AWS credentials
 * needed — `init -backend=false` only downloads the provider schema. Set
 * TF_PLUGIN_CACHE_DIR so the provider downloads once and every dir reuses it.
 */

import { execFile } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readLaunch } from "@launchfile/sdk";
import { translate } from "./translate.js";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const BIN = process.env.TERRAFORM_BIN ?? "terraform";

interface Source {
	name: string;
	path: string;
}

function sources(examplesOnly: boolean): Source[] {
	const out: Source[] = [];
	const examplesDir = resolve(ROOT, "spec", "examples");
	if (existsSync(examplesDir)) {
		for (const f of readdirSync(examplesDir)) {
			if (f.endsWith(".yaml") || f.endsWith(".yml")) {
				out.push({
					name: `ex-${f.replace(/\.ya?ml$/, "")}`,
					path: resolve(examplesDir, f),
				});
			}
		}
	}
	// Provider-local regression fixtures — always swept (incl. --examples / CI),
	// so cases the spec examples don't exercise (e.g. a shell ${VAR} in a command)
	// still gate the emitted HCL.
	const fixturesDir = resolve(HERE, "..", "fixtures");
	if (existsSync(fixturesDir)) {
		for (const f of readdirSync(fixturesDir)) {
			if (f.endsWith(".yaml") || f.endsWith(".yml")) {
				out.push({
					name: `fix-${f.replace(/\.ya?ml$/, "")}`,
					path: resolve(fixturesDir, f),
				});
			}
		}
	}
	if (!examplesOnly) {
		const catalogDir = resolve(ROOT, "catalog", "apps");
		if (existsSync(catalogDir)) {
			for (const app of readdirSync(catalogDir)) {
				const lf = resolve(catalogDir, app, "Launchfile");
				if (existsSync(lf)) out.push({ name: `cat-${app}`, path: lf });
			}
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function validateOne(
	src: Source,
	workRoot: string,
): Promise<{ ok: boolean; detail: string }> {
	const launch = readLaunch(readFileSync(src.path, "utf8"));
	const { hcl } = translate(launch);
	const dir = mkdtempSync(join(workRoot, `${src.name}-`));
	writeFileSync(join(dir, "main.tf"), hcl);
	try {
		// Array-based exec: arguments bypass the shell entirely (CWE-78 safe).
		await run(BIN, ["init", "-backend=false", "-input=false", "-no-color"], {
			cwd: dir,
		});
		await run(BIN, ["validate", "-no-color"], { cwd: dir });
		return { ok: true, detail: "" };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message: string };
		return {
			ok: false,
			detail: (e.stderr || e.stdout || e.message)
				.trim()
				.split("\n")
				.slice(0, 12)
				.join("\n"),
		};
	}
}

async function main(): Promise<void> {
	const examplesOnly = process.argv.includes("--examples");
	const list = sources(examplesOnly);
	const workRoot = mkdtempSync(join(tmpdir(), "lf-aws-validate-"));
	let pass = 0;
	const failures: string[] = [];

	for (const src of list) {
		const result = await validateOne(src, workRoot);
		if (result.ok) {
			pass += 1;
			process.stdout.write(`ok    ${src.name}\n`);
		} else {
			failures.push(src.name);
			process.stdout.write(`FAIL  ${src.name}\n${result.detail}\n`);
		}
	}

	process.stdout.write(`\n${pass}/${list.length} valid (${BIN})\n`);
	if (failures.length > 0) {
		process.stderr.write(`Invalid HCL for: ${failures.join(", ")}\n`);
		process.exit(1);
	}
}

main().catch((err) => {
	process.stderr.write(`${(err as Error).message}\n`);
	process.exit(1);
});
