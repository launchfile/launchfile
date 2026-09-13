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
	/**
	 * Platform-injected app properties (D-33, D-35). Standard set: url, host,
	 * port, name, authority, scheme, tls. Providers may expose additional
	 * properties as platform-specific extensions. The provider populates this
	 * from its routing strategy at deploy time — see {@link deriveAppUrlProperties}
	 * for the authority/scheme/tls trio.
	 */
	app?: Record<string, string | number>;
	/**
	 * Provider-resolved storage properties (D-39) — home #3 of D-36's varying
	 * value litmus. Keyed by the volume name declared in `storage:`. Each volume
	 * exposes `path`: the filesystem path the provider actually provisioned for
	 * that volume — the declared container path under a container provider, a
	 * host directory under a native provider. The provider populates this from
	 * its storage strategy at deploy time. Reserved namespace, checked before
	 * user-named resources; unknown volume/property resolves to undefined (caller
	 * falls back to "" or `:-default`), matching `$app.*` (see {@link ResolverContext.app}).
	 */
	storage?: Record<string, Record<string, string>>;
	/**
	 * Per-endpoint publication context (D-63): the public address of every
	 * named published endpoint, keyed by the `provides` entry's `name` (D-6).
	 * The primary endpoint's entry is the same value as `$app.*`, from the
	 * same derivation. A sibling of {@link ResolverContext.app}, never nested
	 * inside it: the two-segment `$app.<prop>` branch stringifies whatever it
	 * finds, and a map under `app.endpoints` would resolve `$app.endpoints`
	 * to `"[object Object]"`. Reserved namespace, checked before user-named
	 * resources. A provider that publishes no per-endpoint address registers
	 * {@link UNPUBLISHED_APP_ENDPOINT} for each name, or nothing at all —
	 * either way the form resolves `""` (L-4).
	 */
	appEndpoints?: Record<string, AppEndpointProperties>;
	/**
	 * The `uses` each resource entry declares, keyed by the entry's
	 * `name ?? type` — the same key as {@link ResolverContext.resources}. A
	 * resource listed here resolves `$<resource>.<use>.<property>` strictly:
	 * the use must be declared and the property registered under the dotted
	 * key `<use>.<property>` in the resource's map, or resolution throws
	 * {@link UnresolvedUseError}. The last-segment fallback the multi-segment
	 * branch keeps for every other resource does not apply, so a mistyped use
	 * or property never resolves to the instance value behind it. A resource
	 * absent from this map keeps the general rules.
	 */
	uses?: Record<string, readonly string[]>;
}

/**
 * A `$<resource>.<use>.<property>` reference that the resource's declared
 * uses cannot answer: the use is not declared on the entry, or the property is
 * not one the use registers. Thrown rather than resolved `""`, and not
 * softened by a `:-default` — the path is wrong, not empty.
 */
export class UnresolvedUseError extends Error {
	readonly resource: string;
	readonly use: string;
	readonly property: string;

	constructor(resource: string, use: string, property: string, declared: readonly string[]) {
		const path = `$${resource}.${use}.${property}`;
		super(
			declared.includes(use)
				? `${path} does not resolve: use "${use}" on ${resource} registers no property "${property}"`
				: `${path} does not resolve: ${resource} declares no use "${use}" (declared: ${declared.join(", ")})`,
		);
		this.name = "UnresolvedUseError";
		this.resource = resource;
		this.use = use;
		this.property = property;
	}
}

/**
 * The properties `$app.endpoints.<name>.*` addresses (D-63): the standard
 * `$app.*` set (D-33, D-35) less `name`, which names the app rather than an
 * endpoint.
 */
export const APP_ENDPOINT_PROPERTIES = [
	"url",
	"host",
	"port",
	"scheme",
	"authority",
	"tls",
] as const;

export type AppEndpointProperty = (typeof APP_ENDPOINT_PROPERTIES)[number];

/**
 * One named published endpoint's public address (D-63), each field defined
 * per endpoint exactly as the `$app.*` entry defines it for the primary: the
 * published host-side port, never the container port; `scheme`, `tls` and
 * `url` from the effective listener (D-61 rule 2). A `tcp`/`udp` endpoint has
 * no origin, so its `url` and `scheme` are `""` and its `tls` is `"false"`.
 * Every field is `""` when the provider publishes no address for it.
 */
export interface AppEndpointProperties {
	url: string;
	host: string;
	/** Published host-side port; `""` when the provider publishes no address. */
	port: number | string;
	scheme: string;
	authority: string;
	tls: string;
}

/**
 * The answer for an endpoint the provider publishes no address for (D-63
 * rule 4): every property `""`, so the form degrades exactly as an unknown
 * `$app.*` property does (L-4).
 */
export const UNPUBLISHED_APP_ENDPOINT: Readonly<AppEndpointProperties> =
	Object.freeze({ url: "", host: "", port: "", scheme: "", authority: "", tls: "" });

/**
 * Derive the URL-shaped members of the standard `$app.*` set (D-35) from a
 * resolved public URL: `authority` (WHATWG URL `host` — hostname plus port,
 * port omitted when it's the default for the scheme), `scheme` (`http`/`https`),
 * and `tls` (the string `"true"` when https, else `"false"`).
 *
 * A provider computes `$app.url` for its routing strategy, then spreads this to
 * get the split-field tokens for free, keeping a single definition consistent
 * with the spec. An empty or unparseable URL (e.g. an app with no exposed
 * component) yields empty strings, so the tokens degrade to "" like any other
 * unresolved `$app.*` property.
 */
export function deriveAppUrlProperties(
	url: string,
): { authority: string; scheme: string; tls: string } {
	try {
		const u = new URL(url);
		return {
			authority: u.host,
			scheme: u.protocol.replace(/:$/, ""),
			tls: u.protocol === "https:" ? "true" : "false",
		};
	} catch {
		return { authority: "", scheme: "", tls: "" };
	}
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
 * The reference body after a leading `$`: a letter, then any mix of letters,
 * digits, `_`, `.`, `[`, `]`, `|` and `-`.
 *
 * One grammar serves all three positions — whole value (`$secrets.api-key`),
 * braced (`${secrets.api-key}`) and embedded mid-string (`cli --key
 * $secrets.api-key`). A name that resolves in one position resolves in every
 * position; a narrower embedded class would truncate a hyphenated name at the
 * hyphen and re-emit the remainder as literal text.
 */
const REF_BODY = "[a-zA-Z][a-zA-Z0-9_.\\[\\]|-]*";
/** Entire value is one bare reference: `$secrets.api-key` */
const WHOLE_VALUE_REF = new RegExp(`^\\$(${REF_BODY})$`);
/** Entire value is one braced reference: `${port:-5432}` */
const WHOLE_VALUE_BRACED_REF = new RegExp(`^\\$\\{(${REF_BODY})(?::([^}]*))?\\}$`);
/** A bare reference at the head of the remaining template text */
const EMBEDDED_REF = new RegExp(`^\\$(${REF_BODY})`);

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
	const simpleMatch = WHOLE_VALUE_REF.exec(value);
	if (simpleMatch) {
		const { path, transforms } = splitTransforms(simpleMatch[1]!);
		return { kind: "reference", path, ...(transforms.length > 0 && { transforms }) };
	}

	// Check if entire string is a single ${prop} or ${prop:-default}
	// Allows pipe transforms: ${prop|base64:-fallback}
	const bracedSimple = WHOLE_VALUE_BRACED_REF.exec(value);
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
			const bareMatch = EMBEDDED_REF.exec(remaining);
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
 * 1. Starts with "app" → platform-injected app property (reserved namespace, D-33);
 *    "app.endpoints.<name>.<prop>" → per-endpoint publication context (D-63)
 * 2. Starts with "secrets" → app-wide secret lookup
 * 3. Starts with "components" → component lookup
 * 4. Starts with "storage" → provider-resolved storage property (reserved namespace, D-39)
 * 5. Single segment → enclosing resource property
 * 6. Multi-segment → first segment is resource name, rest is property. For a
 *    resource whose entry declares `uses`, a three-or-more-segment path is
 *    `<resource>.<use>.<property>` and resolves from the use's registered
 *    properties or throws — no fallback (see {@link ResolverContext.uses}).
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

/**
 * Read one own property of a context record.
 *
 * Every record in a {@link ResolverContext} is a plain object built by a caller
 * (a provider, the CLI, a downstream consumer), so it inherits
 * `Object.prototype`. A bare index would hand back `constructor`, `toString`,
 * `valueOf` and friends as if the app had declared them, instead of degrading
 * to undefined and letting the caller's empty-string fallback fire (D-33,
 * D-39, L-4). The guard has to live at the read site: the contexts are not
 * ours to give a null prototype.
 *
 * A key that is present with an `undefined` value still yields `undefined`, so
 * the `??` fallbacks below behave exactly as a bare index did.
 */
function own<T>(record: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Look up a property path in the resolver context */
function resolvePath(
	path: string[],
	context: ResolverContext,
): string | undefined {
	if (path.length === 0) return undefined;

	const first = path[0]!;

	// app.prop → platform-injected app property (reserved namespace, D-33).
	// Checked first so a user-named resource cannot shadow it. Unknown
	// properties resolve to undefined (caller falls back to "" or `:-default`).
	if (first === "app" && path.length === 2 && context.app) {
		const propName = path[1]!;
		const val = own(context.app, propName);
		if (val !== undefined) return String(val);
		return undefined;
	}

	// app.endpoints.<name>.<prop> → per-endpoint publication context (D-63).
	// Reserved with the rest of `$app.*`, so it is checked before any
	// user-named resource. Only the four-segment form addresses a value: the
	// two-segment `$app.endpoints` falls to the branch above (no `endpoints`
	// key lives in `context.app`), and every other length, an unknown name,
	// and an unknown property resolve to undefined — "" or `:-default` at the
	// caller (L-4). `validate` warns on those forms; the resolver stays silent.
	if (first === "app" && path[1] === "endpoints") {
		if (path.length !== 4 || !context.appEndpoints) return undefined;
		const name = path[2]!;
		if (!Object.hasOwn(context.appEndpoints, name)) return undefined;
		const prop = path[3]!;
		if (!(APP_ENDPOINT_PROPERTIES as readonly string[]).includes(prop)) {
			return undefined;
		}
		return String(context.appEndpoints[name]![prop as AppEndpointProperty]);
	}

	// secrets.name → app-wide generated secret
	if (first === "secrets" && path.length === 2 && context.secrets) {
		const secretName = path[1]!;
		const val = own(context.secrets, secretName);
		if (val !== undefined) return String(val);
	}

	// components.name.prop
	if (first === "components" && path.length >= 3 && context.components) {
		const componentName = path[1]!;
		const component = own(context.components, componentName);
		if (!component) return undefined;
		// Try remaining path as dotted key, then just last segment
		const propKey = path.slice(2).join(".");
		const val =
			own(component, propKey) ?? own(component, path[path.length - 1]!);
		return val !== undefined ? String(val) : undefined;
	}

	// storage.name.prop → provider-resolved storage property (reserved namespace,
	// D-39). Checked before user-named resources so a volume (or resource) named
	// "storage" cannot shadow it. Unknown volume or property resolves to undefined
	// (caller falls back to "" or `:-default`), matching $app.* and L-4.
	if (first === "storage" && path.length === 3 && context.storage) {
		const volume = own(context.storage, path[1]!);
		if (!volume) return undefined;
		const val = own(volume, path[2]!);
		return val !== undefined ? String(val) : undefined;
	}

	// Single segment → enclosing resource
	if (path.length === 1 && context.resource) {
		const val = own(context.resource, first);
		if (val !== undefined) return String(val);
	}

	// <resource>.<use>.<property> on an entry that declares `uses`: strict.
	// Each covered use registers its properties under the dotted key
	// `<use>.<property>`; nothing else answers, and a miss throws rather than
	// falling through to the last-segment probe below, which would hand back
	// the instance value for a use the entry never declared.
	if (path.length >= 3 && context.uses) {
		const declared = own(context.uses, first);
		if (declared) {
			const use = path[1]!;
			const property = path.slice(2).join(".");
			const resource = context.resources
				? own(context.resources, first)
				: undefined;
			const val =
				declared.includes(use) && resource
					? own(resource, `${use}.${property}`)
					: undefined;
			if (val === undefined) {
				throw new UnresolvedUseError(first, use, property, declared);
			}
			return String(val);
		}
	}

	// Multi-segment → named resource
	if (path.length >= 2 && context.resources) {
		const resource = own(context.resources, first);
		if (resource) {
			const propKey = path.slice(1).join(".");
			const val =
				own(resource, propKey) ?? own(resource, path[path.length - 1]!);
			if (val !== undefined) return String(val);
		}
	}

	// Fallback: enclosing resource with dotted key
	if (context.resource) {
		const fullKey = path.join(".");
		const val = own(context.resource, fullKey);
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
