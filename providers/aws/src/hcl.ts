/**
 * A small, dependency-free HCL (HashiCorp Configuration Language) emitter.
 *
 * Just enough to render valid Terraform: blocks, attributes, quoted strings,
 * raw expressions (references / interpolations), lists, maps, and heredocs.
 * It does NOT model Terraform semantics — it renders syntax. Validity against
 * the AWS provider schema is the job of `terraform validate` in CI.
 *
 * Two string worlds live here, and keeping them apart is the whole point:
 *   - a plain JS string is rendered as a *literal* — any `${...}` it contains
 *     is escaped to `$${...}` so user data can never smuggle interpolation in;
 *   - a `raw(...)` value is emitted verbatim — that is how we deliberately
 *     reference Terraform attributes (`aws_lb.main.dns_name`) and build the
 *     interpolated strings that carry a resource's runtime address into env.
 */

/** A raw, unquoted HCL expression — a reference, function call, or pre-quoted interpolated string. */
export interface HclRaw {
	readonly __hclRaw: true;
	readonly expr: string;
}

export type HclValue =
	| string
	| number
	| boolean
	| HclRaw
	| HclValue[]
	| { [key: string]: HclValue };

/** Mark a string as a raw HCL expression (emitted without quoting or escaping). */
export function raw(expr: string): HclRaw {
	return { __hclRaw: true, expr };
}

export function isRaw(value: unknown): value is HclRaw {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as HclRaw).__hclRaw === true
	);
}

/** A bare attribute reference, e.g. `aws_vpc.main.id`. */
export function ref(...path: string[]): HclRaw {
	return raw(path.join("."));
}

/**
 * Build a raw, double-quoted HCL string that intentionally preserves `${...}`
 * Terraform interpolations. Use this for env values that must carry a resource
 * reference (e.g. `"postgres://...@${aws_db_instance.db.address}:5432/app"`).
 * Embedded `"` are escaped; interpolation braces are left intact.
 */
export function interp(text: string): HclRaw {
	return raw(`"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
}

/** An indented heredoc (`<<-EOT`), correct under any block nesting. */
export function heredoc(body: string, tag = "EOT"): HclRaw {
	const lines = body.replace(/\n$/, "").split("\n");
	return raw([`<<-${tag}`, ...lines, tag].join("\n"));
}

function escapeString(value: string): string {
	return (
		value
			.replace(/\\/g, "\\\\")
			.replace(/"/g, '\\"')
			.replace(/\n/g, "\\n")
			.replace(/\t/g, "\\t")
			// Neutralize Terraform interpolation/directive markers in literal strings.
			// Use function replacements: in a string replacement, `$$` would collapse to `$`.
			.replace(/\$\{/g, () => "$${")
			.replace(/%\{/g, () => "%%{")
	);
}

function indent(text: string, pad = "  "): string {
	return text
		.split("\n")
		.map((line) => (line.length > 0 ? pad + line : line))
		.join("\n");
}

export function renderValue(value: HclValue): string {
	if (isRaw(value)) return value.expr;
	if (typeof value === "string") return `"${escapeString(value)}"`;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		return `[${value.map(renderValue).join(", ")}]`;
	}
	// Object → multi-line map.
	const entries = Object.entries(value);
	if (entries.length === 0) return "{}";
	const body = entries.map(([k, v]) => `${k} = ${renderValue(v)}`).join("\n");
	return `{\n${indent(body)}\n}`;
}

/** Render a single `name = value` attribute line. */
export function attr(name: string, value: HclValue): string {
	return `${name} = ${renderValue(value)}`;
}

/**
 * Render a block. `body` lines are already-rendered attributes (via `attr`) or
 * nested blocks (via `block`); they are indented one level. Empty body → `{}`.
 */
export function block(type: string, labels: string[], body: string[]): string {
	const head = [type, ...labels.map((l) => `"${l}"`)].join(" ");
	if (body.length === 0) return `${head} {}`;
	return `${head} {\n${indent(body.join("\n"))}\n}`;
}

/** A Terraform document: a list of top-level blocks joined by blank lines. */
export function document(blocks: string[]): string {
	return `${blocks.join("\n\n")}\n`;
}

/** Sanitize an arbitrary name (kebab, dots) into a valid Terraform identifier label. */
export function tfName(name: string): string {
	const cleaned = name
		.replace(/[^a-zA-Z0-9_]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	const safe = cleaned.length > 0 ? cleaned : "x";
	// Labels may not start with a digit.
	return /^[0-9]/.test(safe) ? `_${safe}` : safe;
}
