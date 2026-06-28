#!/usr/bin/env bun
/**
 * Generate the aggregate conformance report by translating every spec example
 * and tested catalog app, then writing `CONFORMANCE.md`. This is the probe's
 * primary artifact: a single document that says, across real Launchfiles, what
 * the same file maps to on AWS and where it falls short.
 *
 *   bun run conformance            # writes ./CONFORMANCE.md
 *   bun run conformance --check    # exits non-zero if the report is stale
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLaunch } from "@launchfile/sdk";
import { type ConformanceEntry, renderConformanceReport } from "./gaps.js";
import { translate } from "./translate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const REPORT_PATH = resolve(HERE, "..", "CONFORMANCE.md");

/** The Launchfiles we hold ourselves to: spec examples + the tested catalog apps. */
function sources(): string[] {
	const out: string[] = [];

	const examplesDir = resolve(ROOT, "spec", "examples");
	if (existsSync(examplesDir)) {
		for (const f of readdirSync(examplesDir)) {
			if (f.endsWith(".yaml") || f.endsWith(".yml"))
				out.push(resolve(examplesDir, f));
		}
	}

	const catalogDir = resolve(ROOT, "catalog", "apps");
	if (existsSync(catalogDir)) {
		for (const app of readdirSync(catalogDir)) {
			const lf = resolve(catalogDir, app, "Launchfile");
			if (existsSync(lf)) out.push(lf);
		}
	}

	return out.sort();
}

function build(): { report: string; failures: string[] } {
	const entries: ConformanceEntry[] = [];
	const failures: string[] = [];

	for (const path of sources()) {
		const rel = path.replace(`${ROOT}/`, "");
		try {
			const launch = readLaunch(readFileSync(path, "utf8"));
			const { conformance } = translate(launch);
			entries.push({ name: launch.name, source: rel, conformance });
		} catch (err) {
			failures.push(`${rel}: ${(err as Error).message}`);
		}
	}

	return { report: renderConformanceReport(entries), failures };
}

function main(): void {
	const check = process.argv.includes("--check");
	const { report, failures } = build();

	for (const f of failures) process.stderr.write(`skip (unparseable): ${f}\n`);

	if (check) {
		const current = existsSync(REPORT_PATH)
			? readFileSync(REPORT_PATH, "utf8")
			: "";
		if (current !== report) {
			process.stderr.write(
				"CONFORMANCE.md is stale — run `bun run conformance`\n",
			);
			process.exit(1);
		}
		process.stdout.write("CONFORMANCE.md is up to date\n");
		return;
	}

	writeFileSync(REPORT_PATH, report);
	process.stdout.write(`Wrote ${REPORT_PATH}\n`);
}

main();
