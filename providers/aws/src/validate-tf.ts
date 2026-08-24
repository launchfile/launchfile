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
 *
 * `init` costs seconds per directory; `validate` costs ~1s. So sources that
 * declare identical `required_providers` share a single initialized directory —
 * one init, then a symlinked `.terraform` per source — and the validates run
 * concurrently (`VALIDATE_TF_CONCURRENCY` to override the default).
 */

import { execFile } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
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

const INIT_ATTEMPTS = 3;

/** Provider downloads come off the network, so a reset connection says nothing
 * about the emitted HCL. Retry with backoff; only a repeated failure is real. */
async function init(dir: string): Promise<void> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			// Array-based exec: arguments bypass the shell entirely (CWE-78 safe).
			await run(BIN, ["init", "-backend=false", "-input=false", "-no-color"], {
				cwd: dir,
			});
			return;
		} catch (err) {
			if (attempt >= INIT_ATTEMPTS) throw err;
			process.stdout.write(
				`retry ${BIN} init (attempt ${attempt}/${INIT_ATTEMPTS} failed)\n`,
			);
			await new Promise((r) => setTimeout(r, attempt * 3000));
		}
	}
}

/** The emitted `terraform { ... }` block, brace-matched. Two sources with the
 * same block need the same plugins, so one `init` serves both. Sources whose
 * block can't be found get their own init — correctness over speed. */
function requiredProvidersKey(hcl: string, fallback: string): string {
	const start = hcl.indexOf("terraform {");
	if (start === -1) return fallback;
	let depth = 0;
	for (let i = hcl.indexOf("{", start); i < hcl.length; i += 1) {
		if (hcl[i] === "{") depth += 1;
		else if (hcl[i] === "}") {
			depth -= 1;
			if (depth === 0) return hcl.slice(start, i + 1);
		}
	}
	return fallback;
}

interface Candidate {
	src: Source;
	dir: string;
	key: string;
}

/** Point `dir` at an already-initialized `.terraform` instead of running init.
 * Returns false when the platform refuses the symlink (Windows without
 * developer mode), so the caller can fall back to a real init. */
function borrowInit(dir: string, from: string): boolean {
	try {
		symlinkSync(join(from, ".terraform"), join(dir, ".terraform"), "dir");
		const lock = join(from, ".terraform.lock.hcl");
		if (existsSync(lock)) copyFileSync(lock, join(dir, ".terraform.lock.hcl"));
		return true;
	} catch {
		return false;
	}
}

async function validateOne(
	dir: string,
): Promise<{ ok: boolean; detail: string }> {
	try {
		// Array-based exec: arguments bypass the shell entirely (CWE-78 safe).
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

/** Each validate spawns a provider plugin holding the full AWS schema, so this
 * is bounded by memory as much as by cores. */
function concurrency(): number {
	const override = Number(process.env.VALIDATE_TF_CONCURRENCY);
	if (Number.isInteger(override) && override > 0) return override;
	return Math.max(1, Math.min(availableParallelism(), 8));
}

async function mapLimit<T>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
		(async () => {
			for (let i = next++; i < items.length; i = next++) {
				const item = items[i];
				if (item !== undefined) await fn(item);
			}
		})(),
	);
	await Promise.all(workers);
}

async function main(): Promise<void> {
	const examplesOnly = process.argv.includes("--examples");
	const list = sources(examplesOnly);
	const workRoot = mkdtempSync(join(tmpdir(), "lf-aws-validate-"));

	// Translation is pure and cheap — do it all up front so the provider
	// requirements are known before any terraform process starts.
	const candidates: Candidate[] = list.map((src) => {
		const launch = readLaunch(readFileSync(src.path, "utf8"));
		const { hcl } = translate(launch);
		const dir = mkdtempSync(join(workRoot, `${src.name}-`));
		writeFileSync(join(dir, "main.tf"), hcl);
		return { src, dir, key: requiredProvidersKey(hcl, src.name) };
	});

	const groups = new Map<string, Candidate[]>();
	for (const c of candidates) {
		const group = groups.get(c.key);
		if (group) group.push(c);
		else groups.set(c.key, [c]);
	}

	const initFailures: string[] = [];
	for (const group of groups.values()) {
		const leader = group[0];
		if (!leader) continue;
		try {
			await init(leader.dir);
		} catch (err) {
			for (const c of group) {
				initFailures.push(c.src.name);
				process.stdout.write(
					`FAIL  ${c.src.name}\n${(err as Error).message.trim().split("\n").slice(0, 12).join("\n")}\n`,
				);
			}
			continue;
		}
		for (const c of group.slice(1)) {
			if (!borrowInit(c.dir, leader.dir)) await init(c.dir);
		}
	}

	const initialized = candidates.filter(
		(c) => !initFailures.includes(c.src.name),
	);
	const failures = [...initFailures];
	let pass = 0;

	await mapLimit(initialized, concurrency(), async (c) => {
		const result = await validateOne(c.dir);
		if (result.ok) {
			pass += 1;
			process.stdout.write(`ok    ${c.src.name}\n`);
		} else {
			failures.push(c.src.name);
			process.stdout.write(`FAIL  ${c.src.name}\n${result.detail}\n`);
		}
	});

	process.stdout.write(`\n${pass}/${list.length} valid (${BIN})\n`);
	if (failures.length > 0) {
		process.stderr.write(`Invalid HCL for: ${failures.sort().join(", ")}\n`);
		process.exit(1);
	}
}

main().catch((err) => {
	process.stderr.write(`${(err as Error).message}\n`);
	process.exit(1);
});
