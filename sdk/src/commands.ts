/**
 * SDK CLI commands extracted as importable functions.
 *
 * These are used by both the SDK's own CLI (cli.ts) and the
 * unified `launchfile` CLI in packages/launchfile/.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { readLaunch } from "./reader.js";
import type { NormalizedLaunch } from "./types.js";

// --- Color helpers ---

function createFormatter(useColor: boolean) {
	return {
		bold: (s: string): string => (useColor ? `\x1b[1m${s}\x1b[22m` : s),
		green: (s: string): string => (useColor ? `\x1b[32m${s}\x1b[39m` : s),
		red: (s: string): string => (useColor ? `\x1b[31m${s}\x1b[39m` : s),
		yellow: (s: string): string => (useColor ? `\x1b[33m${s}\x1b[39m` : s),
		dim: (s: string): string => (useColor ? `\x1b[2m${s}\x1b[22m` : s),
		cyan: (s: string): string => (useColor ? `\x1b[36m${s}\x1b[39m` : s),
	};
}

// --- Helpers ---

function readFile(path: string, fmt: ReturnType<typeof createFormatter>): string {
	try {
		return readFileSync(path, "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			console.error(`${fmt.red("error:")} File not found: ${path}`);
		} else if (code === "EACCES") {
			console.error(`${fmt.red("error:")} Permission denied: ${path}`);
		} else {
			console.error(`${fmt.red("error:")} Could not read file: ${path}`);
		}
		process.exit(1);
	}
}

function collectRequires(launch: NormalizedLaunch): string[] {
	const types = new Set<string>();
	for (const comp of Object.values(launch.components)) {
		if (comp.requires) {
			for (const req of comp.requires) {
				types.add(req.type);
			}
		}
	}
	return [...types].sort();
}

function formatZodErrors(err: unknown): string[] {
	if (
		err !== null &&
		typeof err === "object" &&
		"issues" in err &&
		Array.isArray((err as { issues: unknown[] }).issues)
	) {
		return (err as { issues: Array<{ path: (string | number)[]; message: string }> }).issues.map(
			(issue) => {
				const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
				return `${path}: ${issue.message}`;
			},
		);
	}

	if (err instanceof Error) {
		return [err.message];
	}

	return [String(err)];
}

// --- Public command functions ---

export interface ValidateOpts {
	json?: boolean;
	quiet?: boolean;
	noColor?: boolean;
}

export interface ValidateResult {
	valid: boolean;
	path: string;
	name?: string;
	components?: string[];
	requires?: string[];
	errors?: string[];
}

/**
 * Validate a Launchfile. Returns the result; exits on failure in non-JSON mode.
 */
export function cmdValidate(path: string, opts: ValidateOpts = {}): ValidateResult {
	const fmt = createFormatter(!opts.noColor && process.stderr.isTTY === true);
	const resolvedPath = resolve(path);
	const yaml = readFile(resolvedPath, fmt);

	try {
		const launch = readLaunch(yaml);
		const componentNames = Object.keys(launch.components);
		const allRequires = collectRequires(launch);

		const result: ValidateResult = {
			valid: true,
			path: resolvedPath,
			name: launch.name,
			components: componentNames,
			requires: allRequires,
		};

		if (opts.json) {
			console.log(JSON.stringify(result, null, 2));
			return result;
		}

		if (!opts.quiet) {
			console.log(`${fmt.green("✓")} ${fmt.bold(launch.name)} is valid`);
			console.log(`  ${fmt.dim("components:")} ${componentNames.join(", ")}`);
			if (allRequires.length > 0) {
				console.log(`  ${fmt.dim("requires:")}   ${allRequires.join(", ")}`);
			}
		}

		return result;
	} catch (err) {
		const errors = formatZodErrors(err);

		const result: ValidateResult = {
			valid: false,
			path: resolvedPath,
			errors,
		};

		if (opts.json) {
			console.log(JSON.stringify(result, null, 2));
			process.exit(1);
		}

		if (opts.quiet) {
			process.exit(1);
		}

		console.error(`${fmt.red("✗")} Validation failed: ${resolvedPath}`);
		for (const e of errors) {
			console.error(`  ${fmt.yellow("→")} ${e}`);
		}
		process.exit(1);
	}
}

/**
 * Print normalized JSON of a Launchfile.
 */
export function cmdInspect(path: string, opts: { noColor?: boolean } = {}): void {
	const fmt = createFormatter(!opts.noColor && process.stderr.isTTY === true);
	const resolvedPath = resolve(path);
	const yaml = readFile(resolvedPath, fmt);

	try {
		const launch = readLaunch(yaml);
		console.log(JSON.stringify(launch, null, 2));
	} catch (err) {
		const errors = formatZodErrors(err);
		console.error(`${fmt.red("error:")} Failed to parse ${resolvedPath}`);
		for (const e of errors) {
			console.error(`  ${fmt.yellow("→")} ${e}`);
		}
		process.exit(1);
	}
}

/**
 * Dump the JSON Schema to stdout.
 */
export function cmdSchema(opts: { schemaPath?: string; noColor?: boolean } = {}): void {
	const fmt = createFormatter(!opts.noColor && process.stderr.isTTY === true);

	if (opts.schemaPath) {
		const content = readFile(resolve(opts.schemaPath), fmt);
		console.log(content);
		return;
	}

	// Try to find schema relative to this file (works in repo context)
	const baseDir = import.meta.dirname ?? dirname(new URL(import.meta.url).pathname);
	const candidates = [
		join(dirname(baseDir), "..", "spec", "schema", "launchfile.schema.json"),
		join(dirname(baseDir), "schema", "launchfile.schema.json"),
	];

	for (const candidate of candidates) {
		try {
			const content = readFileSync(resolve(candidate), "utf-8");
			console.log(content);
			return;
		} catch {
			// try next
		}
	}

	console.error(
		`${fmt.red("error:")} Could not locate JSON Schema.\n` +
			`  Use ${fmt.cyan("--schema-path <path>")} to specify the schema file,\n` +
			`  or download from ${fmt.cyan("https://launchfile.dev/schema/v1")}`,
	);
	process.exit(1);
}
