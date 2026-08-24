/**
 * SDK CLI commands extracted as importable functions.
 *
 * These are used by both the SDK's own CLI (cli.ts) and the
 * unified `launchfile` CLI in packages/launchfile/.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { lintDeprecations } from "./deprecations.js";
import type { Deprecation } from "./deprecations.js";
import { lintLaunch } from "./lint.js";
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

/** True unless the var is unset, empty, "0", or "false" (case-insensitive). */
function envFlag(name: string): boolean {
	const value = process.env[name];
	return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

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
				if (req.host) continue; // capability, not a backing service (D-44)
				types.add(req.type);
			}
		}
	}
	return [...types].sort();
}

/**
 * Collect the app's requested host capabilities (D-44) — the privilege
 * surface `launchfile validate` must always surface. Reads BOTH spellings:
 * `host:`-marked capability entries in requires/supports, and the legacy
 * top-level `host:` block (reported in the capability vocabulary).
 * Each item reads `name=value (required|optional)`.
 */
export function collectHostCapabilities(launch: NormalizedLaunch): string[] {
	const caps = new Set<string>();
	for (const comp of Object.values(launch.components)) {
		const homes = [
			{ entries: comp.requires, mode: "required" },
			{ entries: comp.supports, mode: "optional" },
		] as const;
		for (const { entries, mode } of homes) {
			for (const req of entries ?? []) {
				if (!req.host) continue;
				for (const [capability, value] of Object.entries(req.host)) {
					caps.add(`${capability}=${String(value)} (${mode})`);
				}
			}
		}
		// Legacy block spelling — same capabilities, block form (deprecation is #120)
		const legacy = comp.host;
		if (legacy) {
			if (legacy.docker) {
				caps.add(
					`container_runtime=docker (${legacy.docker === "required" ? "required" : "optional"})`,
				);
			}
			if (legacy.network === "host") caps.add("network=host (required)");
			if (legacy.filesystem && legacy.filesystem !== "none") {
				caps.add(`filesystem=${legacy.filesystem} (required)`);
			}
			if (legacy.privileged) caps.add("privileged=true (required)");
		}
	}
	return [...caps].sort();
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
	/**
	 * Evaluate as if this file were fetched standalone rather than read from
	 * the app's own checkout — enables the D-43 reduced-portability case
	 * (PROVIDERS.md § Source acquisition). Default false (attached), matching
	 * an ordinary local `validate <path>` read.
	 */
	detached?: boolean;
}

export interface ValidateResult {
	valid: boolean;
	path: string;
	name?: string;
	components?: string[];
	requires?: string[];
	/** Requested host capabilities (D-44) — the app's privilege surface. */
	hostCapabilities?: string[];
	errors?: string[];
	/** Non-fatal lint advisories (do not affect `valid`). */
	warnings?: string[];
	/**
	 * Deprecated fields present in the file (P-14/D-42), one entry per field,
	 * each carrying D-42's four parts. Machine-readable by contract — never
	 * prose in `warnings` — and never affects `valid` or the exit code.
	 */
	deprecations?: Deprecation[];
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
		const hostCapabilities = collectHostCapabilities(launch);
		const warnings = lintLaunch(launch, {
			detached: opts.detached,
			suppressPortabilityWarnings: envFlag("LAUNCHFILE_NO_PORTABILITY_WARNINGS"),
		});
		const deprecations = lintDeprecations(launch);

		const result: ValidateResult = {
			valid: true,
			path: resolvedPath,
			name: launch.name,
			components: componentNames,
			requires: allRequires,
			...(hostCapabilities.length > 0 && { hostCapabilities }),
			...(warnings.length > 0 && { warnings }),
			...(deprecations.length > 0 && { deprecations }),
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
			if (hostCapabilities.length > 0) {
				// The D-44 privilege-surface audit line — always emitted when any
				// capability is requested, in either spelling (entry or legacy block).
				console.log(
					`  ${fmt.dim("host capabilities requested:")} ${hostCapabilities.join(", ")}`,
				);
			}
			for (const d of deprecations) {
				// P-14: the deprecation is reported with its migration, never
				// applied. `valid` and the exit code are untouched.
				console.error(
					`  ${fmt.yellow("deprecated:")} ${d.path} — deprecated in ${d.deprecated_in}, ` +
						`removed in ${d.removed_in}; use ${d.replacement}. ${d.hint}`,
				);
			}
			for (const w of warnings) {
				console.error(`  ${fmt.yellow("warning:")} ${w}`);
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
