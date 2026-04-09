/**
 * Expression resolver for the $ syntax in Launchfile set_env values.
 *
 * Syntax:
 *   $prop           — simple property reference
 *   $resource.prop  — cross-resource reference
 *   ${prop}         — explicit form (same as $prop, needed for embedding)
 *   ${prop:-default} — with fallback value
 *   $$              — literal $ (escape)
 *   no $            — literal string
 */

/** Context for resolving expressions */
export interface ResolverContext {
	/** Properties of the enclosing resource (e.g., postgres: { url, host, port }) */
	resource?: Record<string, string | number>;
	/** Named resources (e.g., { postgres: { url, host }, redis: { url } }) */
	resources?: Record<string, Record<string, string | number>>;
	/** Component properties (e.g., { backend: { url, host, port } }) */
	components?: Record<string, Record<string, string | number>>;
	/** App-wide generated secrets (e.g., { "jwt-secret": "abc123" }) */
	secrets?: Record<string, string>;
}

/** Result of parsing a set_env value */
export type ParsedExpression =
	| { kind: "literal"; value: string }
	| { kind: "reference"; path: string[]; fallback?: string; transforms?: string[] }
	| { kind: "template"; parts: Array<TemplatePart> };

export type TemplatePart =
	| { kind: "text"; value: string }
	| { kind: "ref"; path: string[]; fallback?: string; transforms?: string[] };

/**
 * Determine if a set_env value contains any $ references.
 */
export function isExpression(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		if (value[i] === "$") {
			if (i + 1 < value.length && value[i + 1] === "$") {
				i++; // skip escaped $$
				continue;
			}
			return true;
		}
	}
	return false;
}

/**
 * Parse a set_env value into a structured expression.
 *
 * Examples:
 *   "$url"                    → reference ["url"]
 *   "$postgres.host"          → reference ["postgres", "host"]
 *   "$components.backend.url" → reference ["components", "backend", "url"]
 *   "${host}:${port}"         → template with two refs
 *   "${port:-5432}"           → reference ["port"] with fallback "5432"
 *   "postgresql"              → literal "postgresql"
 *   "$$HOME"                  → literal "$HOME"
 */
export function parseExpression(value: string): ParsedExpression {
	if (!isExpression(value)) {
		// No $ references — treat as literal (but unescape $$)
		return { kind: "literal", value: value.replace(/\$\$/g, "$") };
	}

	// Check if this is a simple $prop (entire value is one reference)
	// Allows pipe transforms: $prop|base64
	const simpleMatch = /^\$([a-zA-Z][a-zA-Z0-9_.[\]|-]*)$/.exec(value);
	if (simpleMatch) {
		const { path, transforms } = splitTransforms(simpleMatch[1]!);
		return { kind: "reference", path, ...(transforms.length > 0 && { transforms }) };
	}

	// Check if entire string is a single ${prop} or ${prop:-default}
	// Allows pipe transforms: ${prop|base64:-fallback}
	const bracedSimple = /^\$\{([a-zA-Z][a-zA-Z0-9_.[\]|-]*)(?::([^}]*))?\}$/.exec(value);
	if (bracedSimple) {
		const { path, transforms } = splitTransforms(bracedSimple[1]!);
		// The default separator is ":-" so strip the leading "-"
		const rawDefault = bracedSimple[2];
		const fallback = rawDefault !== undefined && rawDefault.startsWith("-")
			? rawDefault.slice(1)
			: rawDefault;
		return { kind: "reference", path, fallback, ...(transforms.length > 0 && { transforms }) };
	}

	// Complex template — contains ${...} or $prop embedded in a string
	return parseTemplate(value);
}

/** Parse a complex template string with mixed text and expressions */
function parseTemplate(value: string): ParsedExpression {
	const parts: TemplatePart[] = [];
	let remaining = value;
	let textBuffer = "";

	while (remaining.length > 0) {
		// Check for $$ escape
		if (remaining.startsWith("$$")) {
			textBuffer += "$";
			remaining = remaining.slice(2);
			continue;
		}

		// Check for ${...} braced expression
		if (remaining.startsWith("${")) {
			if (textBuffer) {
				parts.push({ kind: "text", value: textBuffer });
				textBuffer = "";
			}

			const closeIdx = remaining.indexOf("}", 2);
			if (closeIdx === -1) {
				textBuffer += remaining;
				remaining = "";
				continue;
			}

			const inner = remaining.slice(2, closeIdx);
			const defaultSep = inner.indexOf(":-");
			if (defaultSep !== -1) {
				const refPart = inner.slice(0, defaultSep);
				const fallback = inner.slice(defaultSep + 2);
				const { path, transforms } = splitTransforms(refPart);
				parts.push({ kind: "ref", path, fallback, ...(transforms.length > 0 && { transforms }) });
			} else {
				const { path, transforms } = splitTransforms(inner);
				parts.push({ kind: "ref", path, ...(transforms.length > 0 && { transforms }) });
			}
			remaining = remaining.slice(closeIdx + 1);
			continue;
		}

		// Check for bare $prop in a template context
		if (remaining.startsWith("$") && remaining.length > 1 && /[a-zA-Z]/.test(remaining[1]!)) {
			if (textBuffer) {
				parts.push({ kind: "text", value: textBuffer });
				textBuffer = "";
			}
			const bareMatch = /^\$([a-zA-Z][a-zA-Z0-9_.|]*)/.exec(remaining);
			if (bareMatch) {
				const { path, transforms } = splitTransforms(bareMatch[1]!);
				parts.push({ kind: "ref", path, ...(transforms.length > 0 && { transforms }) });
				remaining = remaining.slice(bareMatch[0].length);
				continue;
			}
		}

		textBuffer += remaining[0];
		remaining = remaining.slice(1);
	}

	if (textBuffer) {
		parts.push({ kind: "text", value: textBuffer });
	}

	// Simplify: single ref part → reference
	if (parts.length === 1 && parts[0]!.kind === "ref") {
		const ref = parts[0]!;
		return { kind: "reference", path: ref.path, fallback: ref.fallback };
	}

	return { kind: "template", parts };
}

/** Split pipe transforms from a reference string: "secrets.key|base64" → { path, transforms: ["base64"] } */
function splitTransforms(ref: string): { path: string[]; transforms: string[] } {
	const pipeIdx = ref.indexOf("|");
	if (pipeIdx === -1) {
		return { path: parseDotPath(ref), transforms: [] };
	}
	const pathStr = ref.slice(0, pipeIdx);
	const transformStr = ref.slice(pipeIdx + 1);
	return {
		path: parseDotPath(pathStr),
		transforms: transformStr.split("|").filter(Boolean),
	};
}

/**
 * Parse a dot-separated path into segments.
 * Handles bracket notation: "components.backend.instances[0].host"
 */
export function parseDotPath(path: string): string[] {
	const segments: string[] = [];
	let current = "";

	for (let i = 0; i < path.length; i++) {
		const ch = path[i]!;
		if (ch === ".") {
			if (current) segments.push(current);
			current = "";
		} else if (ch === "[") {
			if (current) segments.push(current);
			current = "";
			const closeIdx = path.indexOf("]", i);
			if (closeIdx !== -1) {
				segments.push(path.slice(i + 1, closeIdx));
				i = closeIdx;
			}
		} else {
			current += ch;
		}
	}
	if (current) segments.push(current);

	// Security: cap path depth to prevent abuse via deeply nested expressions
	if (segments.length > 10) {
		throw new Error(`Expression path exceeds maximum of 10 segments: "${path}"`);
	}

	return segments;
}

/**
 * Resolve an expression against a context, returning the final string value.
 *
 * Resolution order for a path:
 * 1. Starts with "secrets" → app-wide secret lookup
 * 2. Starts with "components" → component lookup
 * 3. Single segment → enclosing resource property
 * 4. Multi-segment → first segment is resource name, rest is property
 */
export function resolveExpression(
	value: string,
	context: ResolverContext,
): string {
	const parsed = parseExpression(value);

	if (parsed.kind === "literal") {
		return parsed.value;
	}

	if (parsed.kind === "reference") {
		const resolved = resolvePath(parsed.path, context) ?? parsed.fallback ?? "";
		return applyTransforms(resolved, parsed.transforms);
	}

	return parsed.parts
		.map((part) => {
			if (part.kind === "text") return part.value;
			const resolved = resolvePath(part.path, context) ?? part.fallback ?? "";
			return applyTransforms(resolved, part.transforms);
		})
		.join("");
}

/** Look up a property path in the resolver context */
function resolvePath(
	path: string[],
	context: ResolverContext,
): string | undefined {
	if (path.length === 0) return undefined;

	const first = path[0]!;

	// secrets.name → app-wide generated secret
	if (first === "secrets" && path.length === 2 && context.secrets) {
		const secretName = path[1]!;
		const val = context.secrets[secretName];
		if (val !== undefined) return val;
	}

	// components.name.prop
	if (first === "components" && path.length >= 3 && context.components) {
		const componentName = path[1]!;
		const component = context.components[componentName];
		if (!component) return undefined;
		// Try remaining path as dotted key, then just last segment
		const propKey = path.slice(2).join(".");
		const val = component[propKey] ?? component[path[path.length - 1]!];
		return val !== undefined ? String(val) : undefined;
	}

	// Single segment → enclosing resource
	if (path.length === 1 && context.resource) {
		const val = context.resource[first];
		if (val !== undefined) return String(val);
	}

	// Multi-segment → named resource
	if (path.length >= 2 && context.resources) {
		const resource = context.resources[first];
		if (resource) {
			const propKey = path.slice(1).join(".");
			const val = resource[propKey] ?? resource[path[path.length - 1]!];
			if (val !== undefined) return String(val);
		}
	}

	// Fallback: enclosing resource with dotted key
	if (context.resource) {
		const fullKey = path.join(".");
		const val = context.resource[fullKey];
		if (val !== undefined) return String(val);
	}

	return undefined;
}

/** Apply pipe transforms to a resolved value */
function applyTransforms(value: string, transforms?: string[]): string {
	if (!transforms || transforms.length === 0) return value;
	let result = value;
	for (const transform of transforms) {
		result = applyTransform(result, transform);
	}
	return result;
}

/** Apply a single named transform to a string value */
function applyTransform(value: string, transform: string): string {
	switch (transform) {
		case "base64": {
			// If value looks like hex (even-length, all hex chars), decode as hex bytes first
			if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
				const bytes = new Uint8Array(
					value.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? [],
				);
				return btoa(String.fromCharCode(...bytes));
			}
			// Otherwise base64-encode the raw string
			return btoa(value);
		}
		case "hex":
			return value;
		default:
			return value;
	}
}
