/**
 * Toolchain version discovery.
 *
 * The Launchfile `runtime` field names a language/runtime but deliberately
 * omits a version — the spec directs platforms to discover the concrete
 * version from ecosystem-standard files already present in the repo
 * (`.nvmrc`, `package.json` engines, `.tool-versions`, etc.).
 *
 * This module is the one shared implementation of that multi-format lookup so
 * every provider doesn't reimplement it. It is *discovery*, not *validation*:
 * missing files are normal and never throw, and malformed optional files are
 * skipped rather than surfaced as errors.
 *
 * Each returned version string is the constraint AS DECLARED — it may be an
 * exact version ("1.3.13"), a range (">=1.3.13"), or a Corepack-style spec
 * ("bun@1.3.13"). Callers convert to concrete versions as needed.
 *
 * TOML handling: the SDK has no TOML parser dependency (only `yaml` + `zod`),
 * and adding one for a handful of single-field lookups isn't worth it. The
 * TOML-ish files we read (`pyproject.toml`, `Pipfile`, `rust-toolchain.toml`)
 * are developer-authored config, not attacker input, and we only need one or
 * two scalar fields from each. We extract those with bounded, anchored regexes
 * that avoid backtracking. JSON files (`package.json`, `composer.json`) use
 * `JSON.parse` inside try/catch.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Languages/runtimes we know how to discover versions for. */
export type ToolchainLanguage =
	| "bun"
	| "node"
	| "python"
	| "ruby"
	| "go"
	| "java"
	| "rust"
	| "elixir"
	| "php"
	| "csharp";

/** Where a discovered version came from, so callers can cite it. */
export interface ToolchainSource {
	/** Repo-relative filename the version was read from, e.g. "package.json". */
	file: string;
	/** Field within the file, when applicable, e.g. "packageManager". */
	field?: string;
	/** The declared string, verbatim (e.g. "bun@1.3.13", ">=1.3.13", "v20.11.0"). */
	raw: string;
}

/**
 * Discovered toolchain versions. Each language field holds the version
 * constraint AS DECLARED (exact, range, or Corepack spec). `sources` is keyed
 * by language name and records the origin of each discovered value.
 */
export interface ToolchainVersions {
	bun?: string;
	node?: string;
	python?: string;
	ruby?: string;
	go?: string;
	java?: string;
	rust?: string;
	elixir?: string;
	php?: string;
	csharp?: string;
	sources: Record<string, ToolchainSource>;
}

// Bound how much of any single file we scan with a regex. These config files
// are tiny in practice; this cap just guarantees regex input is small.
const MAX_SCAN_BYTES = 65_536;

/** Read a repo file as text, returning undefined if it's missing/unreadable. */
async function readMaybe(
	repoDir: string,
	filename: string,
): Promise<string | undefined> {
	try {
		const text = await readFile(join(repoDir, filename), "utf-8");
		return text.length > MAX_SCAN_BYTES ? text.slice(0, MAX_SCAN_BYTES) : text;
	} catch {
		// ENOENT (file absent) is the common case; any read error means "skip".
		return undefined;
	}
}

/** Parse JSON text, returning undefined on malformed input (never throws). */
function parseJson(text: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
		) {
			return parsed as Record<string, unknown>;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Read a nested string field from a parsed object, undefined if absent/non-string. */
function getString(
	obj: Record<string, unknown> | undefined,
	...path: string[]
): string | undefined {
	let cur: unknown = obj;
	for (const key of path) {
		if (cur === null || typeof cur !== "object" || Array.isArray(cur))
			return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return typeof cur === "string" ? cur : undefined;
}

/**
 * Parse a `.tool-versions` (asdf/mise) file into a tool→version map.
 * Format is line-based: `<tool> <version>` with `#` comments. Tool aliases
 * `nodejs`→node and `golang`→go are normalized to our language keys.
 */
function parseToolVersions(text: string): Map<string, string> {
	const map = new Map<string, string>();
	const aliases: Record<string, string> = { nodejs: "node", golang: "go" };
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		// First token is the tool, second is the version; ignore extras.
		const parts = trimmed.split(/\s+/);
		const tool = parts[0];
		const version = parts[1];
		if (tool === undefined || version === undefined) continue;
		const key = aliases[tool] ?? tool;
		if (!map.has(key)) map.set(key, version);
	}
	return map;
}

/**
 * Extract a single scalar string field from a TOML body with a bounded regex.
 * `section` is a dotted table path (e.g. "tool.poetry.dependencies"); `key` is
 * the key within it. We match the key only when it appears after its section
 * header (or, for a dotted section, also tolerate the flattened-header form),
 * which is sufficient for the well-known config layouts we target.
 */
function tomlScalar(
	text: string,
	section: string | undefined,
	key: string,
): string | undefined {
	// Match: optional `[section]` header somewhere above, then `key = "value"`.
	// We keep it simple: find every `key = "value"` (or single-quoted) and, if a
	// section is required, ensure the nearest preceding header matches it.
	const keyRe = new RegExp(
		`^\\s*${escapeRegex(key)}\\s*=\\s*["']([^"'\\n]{1,128})["']`,
		"gm",
	);
	if (section === undefined) {
		const m = keyRe.exec(text);
		return m?.[1];
	}
	const headerRe = /^\s*\[([^\]\n]{1,128})\]/gm;
	// Build an ordered list of section header positions.
	const headers: Array<{ index: number; name: string }> = [];
	let hm: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((hm = headerRe.exec(text)) !== null) {
		const name = hm[1];
		if (name !== undefined)
			headers.push({ index: hm.index, name: name.trim() });
	}
	let km: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((km = keyRe.exec(text)) !== null) {
		const value = km[1];
		if (value === undefined) continue;
		// Find the nearest header preceding this key match.
		let currentSection: string | undefined;
		for (const h of headers) {
			if (h.index < km.index) currentSection = h.name;
			else break;
		}
		if (currentSection === section) return value;
	}
	return undefined;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract the version from a `go <ver>` directive in a go.mod file. */
function goModVersion(text: string): string | undefined {
	// `go 1.22` or `go 1.22.0` — anchored to a line start, version bounded.
	const m = /^\s*go\s+(\d+(?:\.\d+){1,2})\b/m.exec(text);
	return m?.[1];
}

/** Extract the version from a `ruby '<ver>'` directive in a Gemfile. */
function gemfileRubyVersion(text: string): string | undefined {
	// `ruby "3.2.0"` or `ruby '3.2.0'`, optionally with a `file:`/`<` form we ignore.
	const m = /^\s*ruby\s+["']([^"'\n]{1,64})["']/m.exec(text);
	return m?.[1];
}

/**
 * Discover toolchain versions for a repository directory.
 *
 * Reads ecosystem-standard files and returns the version constraint AS DECLARED
 * for each language found, plus a `sources` map citing where each came from.
 * Missing files are skipped; a repo with none returns `{ sources: {} }`. This
 * never throws for absent or malformed optional files.
 */
export async function extractToolchainVersions(
	repoDir: string,
): Promise<ToolchainVersions> {
	const result: ToolchainVersions = { sources: {} };

	const set = (
		lang: ToolchainLanguage,
		raw: string,
		source: ToolchainSource,
	): void => {
		if (result[lang] !== undefined) return; // first match wins
		result[lang] = raw;
		result.sources[lang] = source;
	};

	// Read all candidate files up front (cheap, and lets precedence be explicit).
	const [
		packageJsonText,
		toolVersionsText,
		bunVersionText,
		nvmrcText,
		nodeVersionText,
		pythonVersionText,
		pyprojectText,
		pipfileText,
		rubyVersionText,
		gemfileText,
		goModText,
		rustToolchainTomlText,
		rustToolchainText,
		composerJsonText,
	] = await Promise.all([
		readMaybe(repoDir, "package.json"),
		readMaybe(repoDir, ".tool-versions"),
		readMaybe(repoDir, ".bun-version"),
		readMaybe(repoDir, ".nvmrc"),
		readMaybe(repoDir, ".node-version"),
		readMaybe(repoDir, ".python-version"),
		readMaybe(repoDir, "pyproject.toml"),
		readMaybe(repoDir, "Pipfile"),
		readMaybe(repoDir, ".ruby-version"),
		readMaybe(repoDir, "Gemfile"),
		readMaybe(repoDir, "go.mod"),
		readMaybe(repoDir, "rust-toolchain.toml"),
		readMaybe(repoDir, "rust-toolchain"),
		readMaybe(repoDir, "composer.json"),
	]);

	const packageJson =
		packageJsonText !== undefined ? parseJson(packageJsonText) : undefined;
	const toolVersions =
		toolVersionsText !== undefined
			? parseToolVersions(toolVersionsText)
			: undefined;

	// --- bun ---
	// 1) package.json > packageManager (Corepack form "bun@x.y.z")
	const packageManager = getString(packageJson, "packageManager");
	if (packageManager !== undefined && /^bun@/.test(packageManager)) {
		set("bun", packageManager, {
			file: "package.json",
			field: "packageManager",
			raw: packageManager,
		});
	}
	// 2) package.json > engines.bun
	const enginesBun = getString(packageJson, "engines", "bun");
	if (enginesBun !== undefined) {
		set("bun", enginesBun, {
			file: "package.json",
			field: "engines.bun",
			raw: enginesBun,
		});
	}
	// 3) .tool-versions (bun line)
	const tvBun = toolVersions?.get("bun");
	if (tvBun !== undefined) {
		set("bun", tvBun, { file: ".tool-versions", field: "bun", raw: tvBun });
	}
	// 4) .bun-version (whole file)
	if (bunVersionText !== undefined) {
		const v = bunVersionText.trim();
		if (v !== "") set("bun", v, { file: ".bun-version", raw: v });
	}

	// --- node ---
	// packageManager is for the package manager, not the runtime, so the
	// canonical node source is engines.node (not packageManager).
	// 1) package.json > engines.node
	const enginesNode = getString(packageJson, "engines", "node");
	if (enginesNode !== undefined) {
		set("node", enginesNode, {
			file: "package.json",
			field: "engines.node",
			raw: enginesNode,
		});
	}
	// 2) .nvmrc (whole file; may have a leading "v" — kept verbatim in raw)
	if (nvmrcText !== undefined) {
		const v = nvmrcText.trim();
		if (v !== "") set("node", v, { file: ".nvmrc", raw: v });
	}
	// 3) .node-version (whole file)
	if (nodeVersionText !== undefined) {
		const v = nodeVersionText.trim();
		if (v !== "") set("node", v, { file: ".node-version", raw: v });
	}
	// 4) .tool-versions (nodejs/node line)
	const tvNode = toolVersions?.get("node");
	if (tvNode !== undefined) {
		set("node", tvNode, { file: ".tool-versions", field: "node", raw: tvNode });
	}

	// --- python ---
	// 1) .python-version (whole file)
	if (pythonVersionText !== undefined) {
		const v = pythonVersionText.trim();
		if (v !== "") set("python", v, { file: ".python-version", raw: v });
	}
	// 2) pyproject.toml: [project].requires-python, else [tool.poetry.dependencies].python
	if (pyprojectText !== undefined) {
		const requiresPython = tomlScalar(
			pyprojectText,
			"project",
			"requires-python",
		);
		if (requiresPython !== undefined) {
			set("python", requiresPython, {
				file: "pyproject.toml",
				field: "project.requires-python",
				raw: requiresPython,
			});
		} else {
			const poetryPython = tomlScalar(
				pyprojectText,
				"tool.poetry.dependencies",
				"python",
			);
			if (poetryPython !== undefined) {
				set("python", poetryPython, {
					file: "pyproject.toml",
					field: "tool.poetry.dependencies.python",
					raw: poetryPython,
				});
			}
		}
	}
	// 3) .tool-versions (python line)
	const tvPython = toolVersions?.get("python");
	if (tvPython !== undefined) {
		set("python", tvPython, {
			file: ".tool-versions",
			field: "python",
			raw: tvPython,
		});
	}
	// 4) Pipfile (TOML): [requires] python_version = "..."
	if (pipfileText !== undefined) {
		const pipfilePython = tomlScalar(pipfileText, "requires", "python_version");
		if (pipfilePython !== undefined) {
			set("python", pipfilePython, {
				file: "Pipfile",
				field: "requires.python_version",
				raw: pipfilePython,
			});
		}
	}

	// --- ruby ---
	// 1) .ruby-version (whole file)
	if (rubyVersionText !== undefined) {
		const v = rubyVersionText.trim();
		if (v !== "") set("ruby", v, { file: ".ruby-version", raw: v });
	}
	// 2) Gemfile: ruby '<ver>'
	if (gemfileText !== undefined) {
		const v = gemfileRubyVersion(gemfileText);
		if (v !== undefined)
			set("ruby", v, { file: "Gemfile", field: "ruby", raw: v });
	}
	// 3) .tool-versions (ruby line)
	const tvRuby = toolVersions?.get("ruby");
	if (tvRuby !== undefined) {
		set("ruby", tvRuby, { file: ".tool-versions", field: "ruby", raw: tvRuby });
	}

	// --- go ---
	// 1) go.mod: go <ver>
	if (goModText !== undefined) {
		const v = goModVersion(goModText);
		if (v !== undefined) set("go", v, { file: "go.mod", field: "go", raw: v });
	}
	// 2) .tool-versions (golang/go line)
	const tvGo = toolVersions?.get("go");
	if (tvGo !== undefined) {
		set("go", tvGo, { file: ".tool-versions", field: "go", raw: tvGo });
	}

	// --- rust ---
	// 1) rust-toolchain.toml: [toolchain] channel = "..."
	if (rustToolchainTomlText !== undefined) {
		const channel = tomlScalar(rustToolchainTomlText, "toolchain", "channel");
		if (channel !== undefined) {
			set("rust", channel, {
				file: "rust-toolchain.toml",
				field: "toolchain.channel",
				raw: channel,
			});
		}
	}
	// 2) rust-toolchain (whole file — legacy single-line form)
	if (rustToolchainText !== undefined) {
		const v = rustToolchainText.trim();
		// The legacy file is a bare channel name; ignore if it looks like TOML.
		if (v !== "" && !v.includes("[") && !v.includes("=")) {
			set("rust", v, { file: "rust-toolchain", raw: v });
		}
	}
	// 3) .tool-versions (rust line)
	const tvRust = toolVersions?.get("rust");
	if (tvRust !== undefined) {
		set("rust", tvRust, { file: ".tool-versions", field: "rust", raw: tvRust });
	}

	// --- php ---
	// 1) composer.json: config.platform.php, else require.php
	if (composerJsonText !== undefined) {
		const composer = parseJson(composerJsonText);
		const platformPhp = getString(composer, "config", "platform", "php");
		if (platformPhp !== undefined) {
			set("php", platformPhp, {
				file: "composer.json",
				field: "config.platform.php",
				raw: platformPhp,
			});
		} else {
			const requirePhp = getString(composer, "require", "php");
			if (requirePhp !== undefined) {
				set("php", requirePhp, {
					file: "composer.json",
					field: "require.php",
					raw: requirePhp,
				});
			}
		}
	}
	// 2) .tool-versions (php line)
	const tvPhp = toolVersions?.get("php");
	if (tvPhp !== undefined) {
		set("php", tvPhp, { file: ".tool-versions", field: "php", raw: tvPhp });
	}

	// --- java, elixir, csharp — best-effort via .tool-versions only ---
	// These ecosystems lack a single ubiquitous version file; .tool-versions
	// (asdf/mise) is the reliable common denominator. asdf's .NET plugin uses
	// the key "dotnet", so map that to our "csharp" language key.
	const tvJava = toolVersions?.get("java");
	if (tvJava !== undefined) {
		set("java", tvJava, { file: ".tool-versions", field: "java", raw: tvJava });
	}
	const tvElixir = toolVersions?.get("elixir");
	if (tvElixir !== undefined) {
		set("elixir", tvElixir, {
			file: ".tool-versions",
			field: "elixir",
			raw: tvElixir,
		});
	}
	const tvCsharp = toolVersions?.get("dotnet") ?? toolVersions?.get("csharp");
	if (tvCsharp !== undefined) {
		const field = toolVersions?.has("dotnet") ? "dotnet" : "csharp";
		set("csharp", tvCsharp, { file: ".tool-versions", field, raw: tvCsharp });
	}

	return result;
}
