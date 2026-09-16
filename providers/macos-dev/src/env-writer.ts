/**
 * Environment variable resolver and writer.
 *
 * Connects provisioned resource properties to the SDK's expression resolver,
 * then writes the results to .env files.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	type AppEndpointProperties,
	deriveAppUrlProperties,
	resolveExpression,
	isExpression,
	type NormalizedComponent,
	type NormalizedLaunch,
	parseUseKey,
	type ResolverContext,
	type Secret,
	suppliedAppProperties,
	UNPUBLISHED_APP_ENDPOINT,
	type UnsuppliedRequiredEnv,
	unsuppliedRequiredEnv,
	useKeys,
} from "@launchfile/sdk";
import { declaredPrimaryComponent, wireHttpsOrigins } from "./https-origin.js";
import { getProvisioner } from "./resources/index.js";
import type { ResourceProperties } from "./resources/types.js";
import { coveredUses, type DbIndexes, namedDatabases, withCoveredUses } from "./resources/uses.js";
import { generateValue } from "./secret-generator.js";
import { type LaunchState, recordedDbIndexes } from "./state.js";

// Re-export so existing callers in the macos-dev provider keep their import path.
export type { ResolverContext, UnsuppliedRequiredEnv };

/**
 * Compute the $app.* property set (D-33, D-35) for a Launchfile under the
 * macos-dev provider.
 *
 * With no `appUrl`, this provider's own routing strategy answers: the app's
 * "primary" port is the port of the component that declares an `https-origin`
 * entry (D-60 rule 3 — declaration fixes the primary, fulfilled or not), else
 * the first component (in declaration order) that has at least one
 * `exposed: true` provides entry, and `http://localhost:<port>` is the address.
 * Apps with no exposed component get `port: 0` and `url: ""` (and empty
 * authority/scheme/tls).
 *
 * With an `appUrl` — the orchestrator-supplied publication context (D-58) —
 * routing has moved upstream and the supplied URL answers instead, via the
 * SDK's `suppliedAppProperties`: the same derivation `@launchfile/docker` uses,
 * so one Launchfile behind one proxy resolves identical `$app.*` under either
 * provider (P-5). The allocated local ports stay orthogonal — still bound, just
 * not the address anyone reaches the app at.
 *
 * Either way the `authority`/`scheme`/`tls` trio is derived from the resulting
 * URL via the SDK so split-field tokens (e.g. `CMD_DOMAIN: $app.authority`)
 * resolve from one definition (D-35).
 *
 * For multi-exposed-component apps that need a specific component's URL,
 * use `$components.<name>.url` instead — `$app.*` always points at the
 * primary endpoint to give a single, predictable answer (D-58 rule 4). This
 * provider allocates one port per component, so the named endpoint's address
 * is its component's port.
 */
export function computeAppProperties(
	launch: NormalizedLaunch,
	componentPorts: Record<string, number>,
	appUrl?: string,
): Record<string, string | number> {
	if (appUrl !== undefined) return suppliedAppProperties(launch.name, appUrl);

	const primary = primaryComponent(launch, componentPorts);
	const primaryPort = primary === undefined ? 0 : (componentPorts[primary] ?? 0);

	const url = primaryPort > 0 ? `http://localhost:${primaryPort}` : "";
	return {
		name: launch.name,
		host: "localhost",
		port: primaryPort,
		url,
		...deriveAppUrlProperties(url),
	};
}

/**
 * The component whose port is the app's primary endpoint — the one `$app.*`
 * reads and the one a supplied publication URL asserts (D-58 rule 4): the
 * component that declares an `https-origin` entry (D-60 rule 3 — declaration
 * fixes the primary, fulfilled or not), else the first component in
 * declaration order that has an `exposed: true` provides entry and an
 * allocated port. `undefined` when the app publishes nothing. `up` records
 * the answer in state so `status`, which never reads the Launchfile, places
 * the supplied URL on the same component.
 */
export function primaryComponent(
	launch: NormalizedLaunch,
	componentPorts: Record<string, number>,
): string | undefined {
	const declared = declaredPrimaryComponent(launch);
	if (declared !== undefined) {
		// A declared `https-origin` names the primary explicitly, so the
		// positional answer below does not run — the point of D-60 rule 3. The
		// SDK requires the named endpoint to be `exposed: true` on this component.
		return declared;
	}
	for (const [name, component] of Object.entries(launch.components)) {
		// Only endpoints explicitly marked `exposed: true` are reachable from
		// outside the host (D-27), so only they can be the app's public address.
		const hasExposed = component.provides?.some((p) => p.exposed === true) ?? false;
		if (hasExposed && componentPorts[name]) return name;
	}
	return undefined;
}

/**
 * `$app.endpoints.<name>.*` under this provider (D-63 rule 4): every
 * property of every named published endpoint resolves `""`. The allocator
 * hands out one port per **component** (`allocatePorts`, keyed by component
 * name), so a second `exposed: true` entry on a component has no host-side
 * address to publish — not the primary's, and not its own (#294). The
 * primary's entry is `""` too, rather than a copy of `$app.*`, because the
 * per-endpoint form promises a per-endpoint publication this provider does
 * not perform; `$app.*` keeps its own routing answer. Registering the empty
 * answer explicitly, rather than nothing, records that the provider has read
 * the namespace and declined it.
 */
export function computeAppEndpoints(
	launch: NormalizedLaunch,
): Record<string, AppEndpointProperties> {
	const endpoints: Record<string, AppEndpointProperties> = {};
	for (const component of Object.values(launch.components)) {
		for (const p of component.provides ?? []) {
			if (p.name === undefined || p.exposed !== true) continue;
			endpoints[p.name] ??= UNPUBLISHED_APP_ENDPOINT;
		}
	}
	return endpoints;
}

/**
 * Build a ResolverContext from provisioned resources, component ports,
 * secrets, (D-33) the platform-injected app properties, (D-63) the
 * per-endpoint map — `computeAppEndpoints`, which under this provider is
 * every named published endpoint resolving `""` — and the `uses` each
 * resource entry declares (`declaredUses`), which the resolver reads to
 * resolve `$<resource>.<use>.<property>` strictly.
 */
export function buildResolverContext(
	resourceMap: Record<string, ResourceProperties>,
	componentPorts: Record<string, number>,
	secrets: Record<string, string>,
	app: Record<string, string | number>,
	appEndpoints: Record<string, AppEndpointProperties> = {},
	uses: Record<string, readonly string[]> = {},
): ResolverContext {
	// Build components map from ports
	const components: Record<string, Record<string, string | number>> = {};
	for (const [name, port] of Object.entries(componentPorts)) {
		components[name] = {
			url: `http://localhost:${port}`,
			host: "localhost",
			port,
		};
	}

	// Build named resources map
	const resources: Record<string, Record<string, string | number>> = {};
	for (const [name, props] of Object.entries(resourceMap)) {
		const record: Record<string, string | number> = {};
		for (const [k, v] of Object.entries(props)) {
			if (v !== undefined) {
				record[k] = v;
			}
		}
		resources[name] = record;
	}

	return { resources, components, secrets, app, appEndpoints, uses };
}

/**
 * The use keys each resource entry declares (`db`, `db.cache`), keyed like
 * the resource namespace (`name ?? type`, app-global). Same-name entries pool
 * their keys — D-24 says they describe one resource. Host-capability entries
 * have none.
 */
export function declaredUses(
	launch: NormalizedLaunch,
): Record<string, string[]> {
	const uses: Record<string, string[]> = {};
	for (const component of Object.values(launch.components)) {
		for (const entry of [...(component.requires ?? []), ...(component.supports ?? [])]) {
			if (entry.host || !entry.uses) continue;
			const pooled = (uses[entry.name ?? entry.type] ??= []);
			for (const key of useKeys(entry.uses)) {
				if (!pooled.includes(key)) pooled.push(key);
			}
		}
	}
	return uses;
}

/**
 * A resource's property map as `up`, `env` and `bootstrap` all register it:
 * the provisioner's instance vocabulary plus every pooled use this provider
 * covers under `<use>.<property>` / `<use>.<name>.<property>` (D-24:
 * same-name entries describe one resource). `dbIndexes` carries the numbered
 * database each redis `db` use key selects. A pooled `db` key with no index
 * in it stays unregistered, so a `$<resource>.db.<property>` (or
 * `$<resource>.db.<name>.<property>`) reference throws `UnresolvedUseError`
 * instead of falling through to the instance url.
 */
export function registerResource(
	type: string,
	resourceName: string,
	uses: Record<string, readonly string[]>,
	base: ResourceProperties,
	dbIndexes: DbIndexes,
): ResourceProperties {
	const pooled = coveredUses(type, uses[resourceName] ?? []);
	const registered = pooled.filter(
		(key) => parseUseKey(key).use !== "db" || Object.hasOwn(dbIndexes, key),
	);
	return withCoveredUses(type, registered, base, dbIndexes);
}

/**
 * The resource map a subcommand run after `up` (`env`, `bootstrap`) resolves
 * against, rebuilt from state and registered exactly as `up` registered it.
 * Each recorded resource is re-provisioned to read its current properties —
 * every provisioner is idempotent, so this neither re-creates nor corrupts
 * the resource — and a redis `db` use reads back the index `up` recorded
 * rather than one re-derived from the file, which may have changed since. A
 * state file written before the index was recorded leaves `db.*`
 * unregistered, so the strict resolver throws for `$<resource>.db.*` — never
 * the instance url — until the next `up` records it.
 */
export async function resourceMapFromState(
	launch: NormalizedLaunch,
	state: LaunchState,
	projectDir: string,
): Promise<Record<string, ResourceProperties>> {
	const uses = declaredUses(launch);
	const resourceMap: Record<string, ResourceProperties> = {};
	for (const [name, res] of Object.entries(state.resources)) {
		const provisioner = getProvisioner(res.type);
		if (!provisioner) continue;
		const result = await provisioner.provision(
			{ type: res.type, name: res.name },
			{ appName: state.appName, projectDir, databases: namedDatabases(uses[name] ?? []) },
			res,
		);
		resourceMap[name] = registerResource(res.type, name, uses, result.properties, recordedDbIndexes(res));
	}
	return resourceMap;
}

/**
 * The resolver context `up`, `env` and `bootstrap` share, built from the same
 * inputs: the registered resources, the recorded ports and secrets, `$app.*`
 * from the recorded publication context (D-58) with a satisfied
 * `https-origin` wired to the same string (D-60 rule 4), and the declared
 * uses the resolver applies strictly.
 */
export function resolverContextFor(
	launch: NormalizedLaunch,
	resourceMap: Record<string, ResourceProperties>,
	state: LaunchState,
): ResolverContext {
	const appProperties = computeAppProperties(launch, state.ports, state.appUrl);
	wireHttpsOrigins(launch, resourceMap, state.appUrl);
	return buildResolverContext(
		resourceMap,
		state.ports,
		state.secrets,
		appProperties,
		computeAppEndpoints(launch),
		declaredUses(launch),
	);
}

/**
 * The resolved environment for one component, plus what the file did not supply.
 */
export interface ComponentEnvResult {
	/** Keys that actually arrived. An unsupplied `required:` key is ABSENT, never `""`. */
	env: Record<string, string>;
	/**
	 * `required:` variables with no `generator:`, no `default:`, and no
	 * `set_env:` binding that injected (D-52, PROVIDERS.md §10 rule 8). The
	 * caller decides: `up` reads its operator channel then fails by name, `env`
	 * reports them without breaking `eval`.
	 */
	unsupplied: UnsuppliedRequiredEnv[];
}

/**
 * Resolve all environment variables for a single component.
 */
export function resolveComponentEnv(
	component: NormalizedComponent,
	context: ResolverContext,
	resourceMap: Record<string, ResourceProperties>,
	storage?: Record<string, Record<string, string>>,
): ComponentEnvResult {
	const env: Record<string, string> = {};

	// This component's provider-resolved storage paths (D-39). Scoped per
	// component because volume names are component-local — component A's
	// `$storage.cache.path` must not see component B's `cache`.
	const ctx: ResolverContext = storage ? { ...context, storage } : context;

	// 1. Resolve set_env from requires
	for (const req of component.requires ?? []) {
		// A host capability (D-44) is never provisioned, so it has no properties
		// to resolve against. An ungranted capability's set_env vars are omitted
		// rather than resolved to empty strings.
		if (req.host) continue;
		const resourceName = req.name ?? req.type;
		const props = resourceMap[resourceName];
		if (!req.set_env || !props) continue;

		// Build resource-scoped context (enclosing resource)
		const resourceRecord: Record<string, string | number> = {};
		for (const [k, v] of Object.entries(props)) {
			if (v !== undefined) resourceRecord[k] = v;
		}
		const scopedContext: ResolverContext = {
			...ctx,
			resource: resourceRecord,
		};

		for (const [envKey, expr] of Object.entries(req.set_env)) {
			env[envKey] = resolveExpression(expr, scopedContext);
		}
	}

	// 2. Resolve set_env from supports (only if resource was provisioned)
	for (const sup of component.supports ?? []) {
		if (sup.host) continue; // capability, not a backing service (D-44)
		const resourceName = sup.name ?? sup.type;
		const props = resourceMap[resourceName];
		if (!sup.set_env || !props) continue;

		const resourceRecord: Record<string, string | number> = {};
		for (const [k, v] of Object.entries(props)) {
			if (v !== undefined) resourceRecord[k] = v;
		}
		const scopedContext: ResolverContext = {
			...ctx,
			resource: resourceRecord,
		};

		for (const [envKey, expr] of Object.entries(sup.set_env)) {
			env[envKey] = resolveExpression(expr, scopedContext);
		}
	}

	// 3. Resolve component-level env vars
	if (component.env) {
		for (const [key, envVar] of Object.entries(component.env)) {
			if (env[key] !== undefined) continue; // set_env takes precedence

			// A generator outranks a default (D-49 provenance precedence). Filling
			// the default here would win by arriving first — resolveGenerators
			// skips any key already set — and this provider would mint nothing
			// where docker and aws mint a secret, for the same file.
			if (envVar.generator) continue;

			if (envVar.default !== undefined) {
				const defaultStr = String(envVar.default);
				if (isExpression(defaultStr)) {
					env[key] = resolveExpression(defaultStr, ctx);
				} else {
					env[key] = defaultStr;
				}
			}
		}
	}

	// A `required:` var nothing above yielded is left ABSENT and reported, not
	// silently dropped (D-52, PROVIDERS.md §10 rule 8). `generator:` keys were
	// skipped just above but are not unsupplied — `resolveGenerators` mints them
	// — and the shared predicate excludes them for that reason. The test runs
	// after the `set_env` loops so it measures arrival, not declaration.
	const unsupplied = unsuppliedRequiredEnv(component, Object.keys(env));

	return { env, unsupplied };
}

/**
 * Generate all app-wide secrets, reusing values from state when available.
 */
export async function generateSecrets(
	secretDefs: Record<string, Secret> | undefined,
	existingSecrets: Record<string, string>,
): Promise<Record<string, string>> {
	if (!secretDefs) return { ...existingSecrets };

	const secrets = { ...existingSecrets };
	for (const [name, def] of Object.entries(secretDefs)) {
		if (!secrets[name]) {
			secrets[name] = await generateValue(def.generator);
		}
	}
	return secrets;
}

/**
 * Resolve values for env vars that declare generators, preserving minted
 * values across runs (D-49: generate once, then preserve).
 *
 * A `secret` or `uuid` value is read from `generatedEnv` when present, and
 * minted and written into it when absent. The store is keyed
 * `<component>.<ENV_NAME>` — one entry per declaration (D-25), so two
 * components declaring the same variable name hold independent values.
 * `generator: port` is exempt: ports have their own preserved home
 * (`state.ports`) and allocator, and a preserved port produces a bind
 * conflict rather than continuity.
 *
 * Mutates `env` and `generatedEnv` in place. Returns true when a new value
 * was minted into `generatedEnv` — the caller must then persist the state
 * before handing the value to anything, so every site that mints persists.
 */
export async function resolveGenerators(
	component: NormalizedComponent,
	env: Record<string, string>,
	componentName: string,
	generatedEnv: Record<string, string>,
): Promise<boolean> {
	if (!component.env) return false;

	let minted = false;
	for (const [key, envVar] of Object.entries(component.env)) {
		if (env[key] !== undefined) continue;
		if (!envVar.generator) continue;

		if (envVar.generator === "port") {
			env[key] = await generateValue(envVar.generator);
			continue;
		}

		const stateKey = `${componentName}.${key}`;
		const existing = generatedEnv[stateKey];
		if (existing !== undefined) {
			env[key] = existing;
			continue;
		}

		const value = await generateValue(envVar.generator);
		env[key] = value;
		generatedEnv[stateKey] = value;
		minted = true;
	}
	return minted;
}

/**
 * Write resolved env vars to a .env file.
 */
export async function writeEnvFile(
	filePath: string,
	env: Record<string, string>,
): Promise<void> {
	const lines = Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => {
			// Quote values that contain spaces, #, or newlines. Escape backslashes
			// first, then quotes — otherwise a value containing a backslash would
			// produce broken or injectable quoting (CWE-116 incomplete escaping).
			if (/[\s#\n]/.test(value)) {
				const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
				return `${key}="${escaped}"`;
			}
			return `${key}=${value}`;
		});

	const content = `# Generated by launch up — do not edit manually\n${lines.join("\n")}\n`;
	// Security: env files contain database URLs with passwords and generated secrets
	await writeFile(filePath, content, { mode: 0o600 });
}

/**
 * Resolve and write env files for all components.
 * Single-component → .env.local at project root.
 * Multi-component → .launchfile/env/<component>.env per component.
 */
export async function writeAllEnvFiles(
	launch: NormalizedLaunch,
	context: ResolverContext,
	resourceMap: Record<string, ResourceProperties>,
	componentPorts: Record<string, number>,
	projectDir: string,
	generatedEnv: Record<string, string>,
): Promise<Record<string, Record<string, string>>> {
	const allEnvs: Record<string, Record<string, string>> = {};
	const componentNames = Object.keys(launch.components);
	const isSingleComponent = componentNames.length === 1 && componentNames[0] === "default";

	for (const [name, component] of Object.entries(launch.components)) {
		const { env } = resolveComponentEnv(component, context, resourceMap);
		await resolveGenerators(component, env, name, generatedEnv);

		// Inject PORT if not already set and component has provides
		const port = componentPorts[name];
		if (port && !env.PORT) {
			env.PORT = String(port);
		}

		allEnvs[name] = env;

		if (isSingleComponent) {
			await writeEnvFile(join(projectDir, ".env.local"), env);
		} else {
			const envDir = join(projectDir, ".launchfile", "env");
			await mkdir(envDir, { recursive: true, mode: 0o700 });
			await writeEnvFile(join(envDir, `${name}.env`), env);
		}
	}

	return allEnvs;
}
