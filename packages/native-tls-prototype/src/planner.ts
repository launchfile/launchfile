import {
	parseLaunchYaml,
	parseExpression,
	validateLaunch,
	type NormalizedLaunch,
	type NormalizedRequirement,
	type Provides,
} from "@launchfile/sdk";

export type TlsMode = "off" | "edge" | "native" | "passthrough" | "reencrypt";

/** Files already materialized inside the application container by the caller. */
export interface CertificateInput {
	certFile: string;
	keyFile: string;
	caFile: string;
}

export interface TlsOptions {
	mode: TlsMode;
	publicUrl: string;
	endpoint?: string;
	certificates?: Record<string, CertificateInput>;
	supportedModes?: TlsMode[];
}

export interface TlsPlan {
	launch: NormalizedLaunch;
	mode: TlsMode;
	publicUrl: string;
	component: string;
	/** Unnamed legacy endpoints use their resolved container port as an identifier. */
	endpoint: string;
	protocol: "http" | "https";
	port: number;
	certificate?: string;
	resources: Record<string, { properties: Record<string, string> }>;
	warnings: string[];
}

type ObjectValue = Record<string, unknown>;
interface Binding { certificate: string; port?: number }
interface Endpoint {
	component: string;
	index: number;
	value: Provides;
	binding?: Binding;
}

const MODES: TlsMode[] = ["off", "edge", "native", "passthrough", "reencrypt"];
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);

function object(value: unknown, label: string): ObjectValue {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as ObjectValue;
}

function keys(value: ObjectValue, allowed: string[], label: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
	}
}

function binding(value: unknown, label: string): Binding {
	const expanded = typeof value === "string" ? { certificate: value } : object(value, label);
	keys(expanded, ["certificate", "port"], label);
	if (typeof expanded.certificate !== "string" || !NAME.test(expanded.certificate)) {
		throw new Error(`${label}.certificate must name a certificate dependency`);
	}
	if (expanded.port !== undefined &&
		(typeof expanded.port !== "number" || !Number.isInteger(expanded.port) ||
			expanded.port < 1 || expanded.port > 65535)) {
		throw new Error(`${label}.port must be an integer between 1 and 65535`);
	}
	return { certificate: expanded.certificate, port: expanded.port as number | undefined };
}

function normalizePublicUrl(value: string, mode: TlsMode): string {
	let url: URL;
	try { url = new URL(value); } catch { throw new Error("publicUrl must be an absolute HTTP(S) URL"); }
	// Do not echo invalid input: it may contain credentials.
	if (!/^https?:\/\//i.test(value) || url.username || url.password || url.search || url.hash ||
		/[\u0000-\u0020\u007f]/.test(value) || !["http:", "https:"].includes(url.protocol)) {
		throw new Error("publicUrl must be an absolute HTTP(S) URL without credentials, query, or fragment");
	}
	const expected = mode === "off" ? "http:" : "https:";
	if (url.protocol !== expected) {
		throw new Error(`TLS mode ${mode} requires an ${expected}// publicUrl`);
	}
	return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
}

function certificateProperties(input: CertificateInput | undefined, name: string, port: number) {
	if (!input) throw new Error(`Native TLS requires supplied certificate material for ${name}`);
	for (const key of ["certFile", "keyFile", "caFile"] as const) {
		const path = input[key];
		if (typeof path !== "string" || !path.startsWith("/") || path.endsWith("/") ||
			/[\u0000-\u001f\u007f]/.test(path) || path.split("/").some((part) => part === "." || part === "..")) {
			throw new Error(`Certificate ${name}.${key} must be an absolute container file path without traversal`);
		}
	}
	return { cert_file: input.certFile, key_file: input.keyFile, ca_file: input.caFile, port: String(port) };
}

function label(endpoint: Endpoint): string {
	return `${endpoint.component}.${endpoint.value.name ?? endpoint.value.port}`;
}

function references(expression: string): Array<{ path: string[]; fallback?: string }> {
	const parsed = parseExpression(expression);
	return parsed.kind === "reference" ? [parsed]
		: parsed.kind === "template" ? parsed.parts.filter((part) => part.kind === "ref") : [];
}

function choose(endpoints: Endpoint[], selector: string | undefined, component?: string): Endpoint {
	const candidates = endpoints.filter((entry) => {
		if (component !== undefined && entry.component !== component) return false;
		return selector === undefined
			? entry.value.exposed === true && ["http", "https"].includes(entry.value.protocol)
			: entry.value.name === selector || label(entry) === selector;
	});
	if (candidates.length !== 1) {
		throw new Error(selector === undefined
			? "Choose --endpoint component.endpoint: the published HTTP(S) endpoint is not unambiguous"
			: `Endpoint ${selector} ${candidates.length ? "is ambiguous; use component.endpoint" : "does not exist in its declared scope"}`);
	}
	return candidates[0]!;
}

/**
 * Compile the proposed TLS syntax to today's SDK representation, without I/O.
 * A successful plan states the routing contract; the deploying adapter must
 * validate certificate bytes, provision that route, and verify its handshake.
 */
export function planTls(yaml: string, options: TlsOptions): TlsPlan {
	if (!MODES.includes(options.mode)) throw new Error(`Unsupported TLS mode: ${options.mode}`);
	if (options.supportedModes && !options.supportedModes.includes(options.mode)) {
		throw new Error(`Provider does not support explicitly selected TLS mode ${options.mode}`);
	}
	if (own(options, "strict") || own(options, "gaps")) throw new Error("Operator strictness is a separate prototype (#444)");
	const warnings: string[] = [];
	const publicUrl = normalizePublicUrl(options.publicUrl, options.mode);
	let raw: ObjectValue;
	try { raw = object(parseLaunchYaml(yaml), "Launchfile"); }
	catch { throw new Error("Invalid Launchfile YAML; source content omitted from diagnostics"); }
	const bindings = new Map<string, Map<number, Binding>>();

	// Inspect before the permissive legacy reader can discard security contracts.
	// Copy only the objects we rewrite, so YAML aliases cannot erase another
	// component's TLS declaration as a side effect of sanitizing the first one.
	function preprocess(source: ObjectValue, component: string, ignoredDefaults = false): ObjectValue {
		if (own(source, "variants")) throw new Error("Generic variants are a separate proposal and are not supported by this TLS prototype");
		if (own(source, "tls") || own(source, "public")) {
			throw new Error(`${component}: tls belongs on provides entries; public belongs in requires`);
		}
		const result = { ...source };
		const localBindings = new Map<number, Binding>();
		if (Array.isArray(source.provides)) {
			result.provides = source.provides.map((entry: unknown, index: number) => {
				const endpoint = object(entry, `${component}.provides[${index}]`);
				if (!own(endpoint, "tls")) return endpoint;
				if (ignoredDefaults) throw new Error("Top-level TLS bindings are not inherited by components; declare them on the component");
				if (endpoint.protocol !== "http" && endpoint.protocol !== "https") {
					throw new Error(`${component}.provides[${index}].tls supports only HTTP/HTTPS listeners`);
				}
				localBindings.set(index, binding(endpoint.tls, `${component}.provides[${index}].tls`));
				const { tls: _tls, ...ordinary } = endpoint;
				return ordinary;
			});
		}
		for (const field of ["requires", "supports"] as const) {
			if (!Array.isArray(source[field])) continue;
			result[field] = source[field].filter((entry: unknown) => {
				if (ignoredDefaults && (entry === "certificate" || (typeof entry === "object" && entry !== null &&
					"type" in entry && entry.type === "certificate"))) {
					throw new Error("Top-level certificate dependencies are not inherited by components; declare them on the component");
				}
				if (typeof entry !== "object" || entry === null || !own(entry, "public")) return true;
				throw new Error("Public HTTPS requirements are a separate prototype (#446)");
			});
		}
		if (!ignoredDefaults) bindings.set(component, localBindings);
		return result;
	}

	const components = raw.components === undefined ? undefined : object(raw.components, "components");
	const multi = components !== undefined && Object.keys(components).length > 0;
	const ordinary = preprocess(raw, "default", multi);
	if (multi) {
		ordinary.components = Object.fromEntries(Object.entries(components).map(([name, value]) =>
			[name, preprocess(object(value, `components.${name}`), name)]));
	}
	let launch: NormalizedLaunch;
	try { launch = validateLaunch(ordinary); }
	catch { throw new Error("Invalid Launchfile fields; source content omitted from diagnostics"); }
	const endpoints = Object.entries(launch.components).flatMap(([component, value]) =>
		(value.provides ?? []).map((endpoint, index): Endpoint => ({
			component, index, value: endpoint, binding: bindings.get(component)?.get(index),
		})));
	const selected = choose(endpoints, options.endpoint);
	if (selected.value.exposed !== true) throw new Error(`Selected endpoint ${label(selected)} must be exposed`);
	if (selected.value.protocol !== "http" && selected.value.protocol !== "https") {
		throw new Error(`Selected endpoint ${label(selected)} must use HTTP or HTTPS`);
	}

	const resolvedDependencies = new Map<Endpoint, { entry: NormalizedRequirement; required: boolean }>();
	for (const endpoint of endpoints) {
		if (!endpoint.binding) continue;
		const scope = launch.components[endpoint.component]!;
		const matches = [
			...(scope.requires ?? []).map((entry) => ({ entry, required: true })),
			...(scope.supports ?? []).map((entry) => ({ entry, required: false })),
		].filter(({ entry }) => (entry.name ?? entry.type) === endpoint.binding!.certificate);
		if (matches.length !== 1 || matches[0]!.entry.type !== "certificate" || matches[0]!.entry.host) {
			throw new Error(`${label(endpoint)}.tls must resolve to exactly one certificate dependency named ${endpoint.binding.certificate} in component ${endpoint.component}`);
		}
		resolvedDependencies.set(endpoint, matches[0]!);
	}

	const native = ["native", "passthrough", "reencrypt"].includes(options.mode);
	if (!native && selected.value.protocol !== "http") {
		throw new Error(`TLS mode ${options.mode} requires an author-declared HTTP base listener; cannot downgrade ${label(selected)}`);
	}
	if (native && !selected.binding) throw new Error(`${label(selected)} does not declare native TLS support`);
	const certificate = native ? selected.binding!.certificate : undefined;
	const active = native ? resolvedDependencies.get(selected) : undefined;
	if (certificate) {
		if (endpoints.some((endpoint) => endpoint !== selected && endpoint.binding?.certificate === certificate)) {
			throw new Error(`Certificate ${certificate} is shared by multiple endpoints; coordinated activation is outside this prototype`);
		}
		// Resources are supplied to today's provider by global name. Refuse a
		// collision even across components instead of accidentally satisfying it.
		for (const [component, scope] of Object.entries(launch.components)) {
			for (const entry of [...(scope.requires ?? []), ...(scope.supports ?? [])]) {
				if (entry !== active?.entry && (entry.name ?? entry.type) === certificate) {
					throw new Error(`Certificate ${certificate} collides with another resource in component ${component}`);
				}
			}
		}
		const activeKeys = new Set(Object.keys(active?.entry.set_env ?? {}));
		const scope = launch.components[selected.component]!;
		for (const entry of [...(scope.requires ?? []), ...(scope.supports ?? [])]) {
			if (entry !== active?.entry && Object.keys(entry.set_env ?? {}).some((key) => activeKeys.has(key))) {
				throw new Error(`Certificate ${certificate} has conflicting set_env wiring with ${entry.name ?? entry.type}`);
			}
		}
	}

	const inactiveCertificates = new Set<string>();
	for (const [component, scope] of Object.entries(launch.components)) {
		for (const entry of scope.requires ?? []) {
			if (entry.type === "certificate" && entry !== active?.entry) {
				throw new Error(`${component} requires native TLS certificate ${entry.name ?? entry.type}; the selected deployment does not activate it`);
			}
		}
		// Certificate availability must never activate an unselected listener.
		// Retain all other optional resources and their existing SDK behavior.
		if (scope.supports) scope.supports = scope.supports.filter((entry) => {
			const retain = entry.type !== "certificate" || entry === active?.entry;
			if (!retain) inactiveCertificates.add(entry.name ?? entry.type);
			return retain;
		});
	}

	const protocol = native ? "https" : "http";
	const port = native ? (selected.binding!.port ?? selected.value.port) : selected.value.port;
	if (native && endpoints.some((entry) => entry !== selected && entry.component === selected.component &&
		entry.value.port === port && entry.value.protocol !== "udp")) {
		throw new Error(`Resolved listener ${label(selected)} conflicts with another endpoint on port ${port}`);
	}
	const resources: TlsPlan["resources"] = certificate
		? { [certificate]: { properties: certificateProperties(options.certificates?.[certificate], certificate, port) } }
		: {};
	for (const [component, scope] of Object.entries(launch.components)) {
		const expressions = [
			...Object.entries(scope.env ?? {}).flatMap(([key, value]) => typeof value.default === "string"
				? [{ label: `${component}.env.${key}`, value: value.default, entry: undefined }] : []),
			...[...(scope.requires ?? []), ...(scope.supports ?? [])].flatMap((entry) =>
				Object.entries(entry.set_env ?? {}).map(([key, value]) => ({ label: `${component}.set_env.${key}`, value, entry }))),
		];
		for (const expression of expressions) {
			for (const ref of references(expression.value)) {
				// Docker currently registers an HTTP URL per component, and the
				// SDK falls back to it even for named endpoint URL references.
				// Replacing the listener cannot repair those sibling addresses.
				if (native && ref.path[0] === "components" && ref.path[1] === selected.component &&
					ref.path.length >= 3 && ref.path.at(-1) === "url") {
					throw new Error(`${expression.label}: canonical Docker sibling URL transport is not supported in this prototype for native TLS component ${selected.component}; its HTTP URL cannot describe the selected HTTPS listener`);
				}
				if (ref.path.length > 1 && inactiveCertificates.has(ref.path[0]!) && ref.fallback === undefined) {
					throw new Error(`${expression.label} references inactive certificate ${ref.path[0]}; put TLS wiring in its certificate set_env`);
				}
				if (certificate) {
					const property = ref.path.length === 1 && expression.entry === active?.entry ? ref.path[0]
						: ref.path.length === 2 && ref.path[0] === certificate ? ref.path[1] : undefined;
					if (property !== undefined && !own(resources[certificate]!.properties, property)) {
						throw new Error(`${expression.label} references unknown certificate property ${property}`);
					}
				}
				const primary = endpoints.find((endpoint) => endpoint.value.exposed === true);
				if (ref.path[0] === "app" && primary !== selected) {
					throw new Error(`${expression.label} uses the primary $app publication context; selecting ${label(selected)} needs a separate endpoint URL context`);
				}
			}
		}
	}
	selected.value.protocol = protocol;
	selected.value.port = port;
	return { launch, mode: options.mode, publicUrl, component: selected.component,
		endpoint: selected.value.name ?? String(selected.value.port), protocol, port, certificate, resources, warnings };
}
