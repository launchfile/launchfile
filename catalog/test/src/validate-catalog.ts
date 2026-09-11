#!/usr/bin/env bun
/**
 * Static validation for every catalog Launchfile — schema plus image-reference
 * policy. Analysis only: nothing is pulled, built, or run.
 *
 * "Schema" here is the SDK's Zod schema (`sdk/src/schema.ts`), which is what
 * `readLaunch` checks — not the published JSON Schema at
 * `spec/schema/launchfile.schema.json`. The two are maintained separately and
 * nothing asserts they agree (issue #179).
 *
 * Two severities:
 *
 *   ERROR   — fails CI. A bare `image: example/app` (silently `:latest`), or an
 *             `@sha256` digest, which `catalog/CONTRIBUTING.md` forbids because
 *             the catalog has no mechanism to re-pin one.
 *   WARNING — reported, never fatal. Scoped to the Launchfiles a change adds or
 *             edits, because `catalog/CONTRIBUTING.md` grandfathers the entries
 *             already on `:latest` and runs no sweep. A whole-catalog warning
 *             that never clears teaches reviewers to skip this job's output.
 *
 * Usage:
 *   bun run src/validate-catalog.ts                    # ERRORs only
 *   CATALOG_DIFF_BASE=<sha> bun run src/validate-catalog.ts   # + WARNINGs on changed files
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { readLaunch } from "../../../sdk/src/reader.ts";

export type Severity = "error" | "warning";

export interface Finding {
	severity: Severity;
	/** Repo-relative path of the file the finding is about. */
	file: string;
	/** 1-based line number in that file, where the finding has one. */
	line?: number;
	message: string;
}

/** One `image:` line as written, before any schema normalization. */
export interface ImageLine {
	/** 1-based line number. */
	line: number;
	/** The reference exactly as written, comment and quotes stripped. */
	ref: string;
	/** A trailing `# …` comment on the same line — the documented `:latest` rationale marker. */
	rationale: string | undefined;
}

/**
 * Pull `image:` lines out of the raw YAML text rather than the parsed document.
 * The rationale marker is a trailing comment, and both the YAML parser and the
 * SDK schema drop comments.
 */
export function collectImageLines(text: string): ImageLine[] {
	const out: ImageLine[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const match = /^\s*image:\s*(.+)$/.exec(raw);
		if (!match) continue;
		let value = (match[1] ?? "").trim();
		let rationale: string | undefined;
		// A `#` inside a quoted reference is not a comment; catalog entries never
		// quote, but the check stays correct if one does.
		const quoted = /^(['"])(.*?)\1\s*(?:#\s*(.*))?$/.exec(value);
		if (quoted) {
			rationale = quoted[3]?.trim() || undefined;
			value = quoted[2] ?? "";
		} else {
			const hash = value.indexOf("#");
			if (hash !== -1) {
				rationale = value.slice(hash + 1).trim() || undefined;
				value = value.slice(0, hash).trim();
			}
		}
		if (!value) continue;
		out.push({ line: i + 1, ref: value, rationale });
	}
	return out;
}

export type ImageRefKind = "bare" | "tagged" | "digest";

export interface ParsedImageRef {
	kind: ImageRefKind;
	/** The repository part, registry and namespace included. */
	name: string;
	/** The tag, for a `tagged` reference. */
	tag?: string;
}

/**
 * Split a reference into repository and tag. A `:` only introduces a tag when it
 * comes after the last `/` — otherwise it is a registry port
 * (`registry.example:5000/app`).
 */
export function parseImageRef(ref: string): ParsedImageRef {
	if (ref.includes("@")) {
		return { kind: "digest", name: ref.slice(0, ref.indexOf("@")) };
	}
	const lastSlash = ref.lastIndexOf("/");
	const lastColon = ref.lastIndexOf(":");
	if (lastColon > lastSlash) {
		return { kind: "tagged", name: ref.slice(0, lastColon), tag: ref.slice(lastColon + 1) };
	}
	return { kind: "bare", name: ref };
}

/** The `images[].name` entries a tested app's `metadata.yaml` records, if it has one. */
export function metadataImageNames(metadataText: string): string[] {
	const doc = parse(metadataText) as unknown;
	if (!doc || typeof doc !== "object") return [];
	const images = (doc as { images?: unknown }).images;
	if (!Array.isArray(images)) return [];
	const names: string[] = [];
	for (const entry of images) {
		if (entry && typeof entry === "object") {
			const name = (entry as { name?: unknown }).name;
			if (typeof name === "string") names.push(name);
		}
	}
	return names;
}

export interface LintInput {
	/** Repo-relative path of the Launchfile. */
	file: string;
	/** Raw Launchfile text. */
	text: string;
	/** App slug, for the re-test command in the drift warning. */
	app: string;
	/** Raw `metadata.yaml` text, where the app has one. */
	metadataText?: string;
	/** Whether this change adds or edits this Launchfile. Gates the WARNINGs. */
	changed: boolean;
}

/**
 * Image-reference policy for one Launchfile. Schema validation is separate —
 * see {@link validateCatalog}.
 */
export function lintImageReferences(input: LintInput): Finding[] {
	const findings: Finding[] = [];
	const metadataNames = input.metadataText ? metadataImageNames(input.metadataText) : undefined;

	for (const image of collectImageLines(input.text)) {
		const parsed = parseImageRef(image.ref);

		if (parsed.kind === "bare") {
			findings.push({
				severity: "error",
				file: input.file,
				line: image.line,
				message:
					`\`image: ${image.ref}\` carries no tag. A bare reference silently means ` +
					"`:latest` and hides the choice from review — write the tag out " +
					"(catalog/CONTRIBUTING.md § Image references).",
			});
			continue;
		}

		if (parsed.kind === "digest") {
			findings.push({
				severity: "error",
				file: input.file,
				line: image.line,
				message:
					`\`image: ${image.ref}\` pins by digest. catalog/CONTRIBUTING.md: "Do not pin ` +
					'by `@sha256` digest" — this catalog has no mechanism to re-pin one, so a ' +
					"digest nobody refreshes is a permanently unpatched image. Use a tag.",
			});
			continue;
		}

		if (!input.changed) continue;

		if (parsed.tag === "latest" && !image.rationale) {
			findings.push({
				severity: "warning",
				file: input.file,
				line: image.line,
				message:
					`\`image: ${image.ref}\` takes \`:latest\` with no stated reason. Prefer the ` +
					"narrowest stable tag upstream maintains; where it publishes nothing " +
					"narrower, say so on the line: " +
					`\`image: ${image.ref}  # upstream publishes no versioned tag\`.`,
			});
		}

		// Drift is only unambiguous when metadata records the SAME repository under
		// a different tag. A repository metadata does not mention at all is more
		// often an image the harness never measured than a stale record.
		const recorded = (metadataNames ?? []).filter(
			(name) => parseImageRef(name).name === parsed.name,
		);
		if (recorded.length > 0 && !recorded.includes(image.ref)) {
			findings.push({
				severity: "warning",
				file: input.file,
				line: image.line,
				message:
					`metadata.yaml records measurements for ${recorded.join(", ")}; the Launchfile ` +
					`now declares ${image.ref}. The measurements are stale — re-run ` +
					`\`bun run src/test-app.ts ${input.app}\` from catalog/test to refresh them. ` +
					"Do not hand-edit the `images:` block; the next test run overwrites it.",
			});
		}
	}

	return findings;
}

/** One catalog entry on disk. */
interface CatalogEntry {
	app: string;
	/** Repo-relative path of the Launchfile. */
	file: string;
	launchfilePath: string;
	metadataPath: string;
}

function discoverEntries(repoRoot: string): CatalogEntry[] {
	const entries: CatalogEntry[] = [];
	for (const tier of ["apps", "drafts"]) {
		const dir = join(repoRoot, "catalog", tier);
		if (!existsSync(dir)) continue;
		for (const app of readdirSync(dir, { withFileTypes: true })) {
			if (!app.isDirectory()) continue;
			const launchfilePath = join(dir, app.name, "Launchfile");
			if (!existsSync(launchfilePath)) continue;
			entries.push({
				app: app.name,
				file: `catalog/${tier}/${app.name}/Launchfile`,
				launchfilePath,
				metadataPath: join(dir, app.name, "metadata.yaml"),
			});
		}
	}
	return entries.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Repo-relative paths this change adds or edits, from `git diff` against `base`.
 * An empty set (no base, or a base this clone cannot resolve) scopes the
 * WARNING checks to nothing, which is the safe direction: they never fail CI.
 */
export function changedPaths(repoRoot: string, base: string | undefined): Set<string> {
	if (!base || /^0+$/.test(base)) return new Set();
	try {
		// Array args, never a shell string: `base` comes from the workflow context.
		const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return new Set(out.split("\n").filter(Boolean));
	} catch {
		process.stderr.write(
			`  note: cannot diff against ${base} — image-policy warnings are scoped to nothing\n`,
		);
		return new Set();
	}
}

export interface ValidationReport {
	files: number;
	findings: Finding[];
}

export function validateCatalog(repoRoot: string, changed: Set<string>): ValidationReport {
	const findings: Finding[] = [];
	const entries = discoverEntries(repoRoot);

	for (const entry of entries) {
		const text = readFileSync(entry.launchfilePath, "utf8");

		try {
			readLaunch(text);
		} catch (err) {
			findings.push({
				severity: "error",
				file: entry.file,
				message: `does not satisfy the Launchfile schema: ${
					err instanceof Error ? err.message : String(err)
				}`,
			});
			// The image lint reads raw lines, so it still applies to a file the
			// schema rejects — a contributor gets every problem in one run.
		}

		findings.push(
			...lintImageReferences({
				file: entry.file,
				text,
				app: entry.app,
				metadataText: existsSync(entry.metadataPath)
					? readFileSync(entry.metadataPath, "utf8")
					: undefined,
				changed: changed.has(entry.file),
			}),
		);
	}

	return { files: entries.length, findings };
}

function main(): void {
	const repoRoot = resolve(import.meta.dirname, "../../..");
	const changed = changedPaths(repoRoot, process.env.CATALOG_DIFF_BASE);
	const { files, findings } = validateCatalog(repoRoot, changed);

	const errors = findings.filter((f) => f.severity === "error");
	const warnings = findings.filter((f) => f.severity === "warning");

	for (const finding of findings) {
		const where = finding.line ? `${finding.file}:${finding.line}` : finding.file;
		const stream = finding.severity === "error" ? process.stderr : process.stdout;
		stream.write(`${finding.severity.toUpperCase()}  ${where}\n    ${finding.message}\n\n`);
	}

	process.stdout.write(
		`${files} catalog Launchfile(s) validated — ` +
			`${errors.length} error(s), ${warnings.length} warning(s)` +
			`${changed.size === 0 ? " (no changed files; warnings not evaluated)" : ""}\n`,
	);

	if (errors.length > 0) process.exit(1);
}

if (import.meta.main) main();
