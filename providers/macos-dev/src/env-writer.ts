/**
 * Environment variable resolver and writer.
 *
 * Connects provisioned resource properties to the SDK's expression resolver,
 * then writes the results to .env files.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	deriveAppUrlProperties,
	resolveExpression,
	isExpression,
	type NormalizedComponent,
	type NormalizedLaunch,
	type ResolverContext,
	type Secret,
	type UnsuppliedRequiredEnv,
	unsuppliedRequiredEnv,
} from "@launchfile/sdk";
import type { ResourceProperties } from "./resources/types.js";
import { generateValue } from "./secret-generator.js";

// Re-export so existing callers in the macos-dev provider keep their import path.
export type { ResolverContext, UnsuppliedRequiredEnv };

/**
 * Compute the $app.* property set (D-33, D-35) for a Launchfile under the
 * macos-dev provider. The app's "primary" port comes from the first component
 * (in declaration order) that has at least one `exposed: true` provides entry.
 * The `authority`/`scheme`/`tls` trio is derived from the resulting URL via the
 * SDK so split-field tokens (e.g. `CMD_DOMAIN: $app.authority`) resolve.
 * Apps with no exposed component get `port: 0` and `url: ""` (and empty
 * authority/scheme/tls).
 *
 * For multi-exposed-component apps that need a specific component's URL,
 * use `$components.<name>.url` instead — `$app.*` always points at the
 * first exposed component to give a single, predictable answer.
 */
export function computeAppProperties(
	launch: NormalizedLaunch,
	componentPorts: Record<string, number>,
): Record<string, string | number> {
	let primaryPort = 0;
	for (const [name, component] of Object.entries(launch.components)) {
		const hasExposed = component.provides?.some((p) => p.exposed !== false) ?? false;
		if (hasExposed && componentPorts[name]) {
			primaryPort = componentPorts[name]!;
			break;
		}
	}

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
 * Build a ResolverContext from provisioned resources, component ports,
 * secrets, and (D-33) the platform-injected app properties.
 */
export function buildResolverContext(
	resourceMap: Record<string, ResourceProperties>,
	componentPorts: Record<string, number>,
	secrets: Record<string, string>,
	app: Record<string, string | number>,
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

	return { resources, components, secrets, app };
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
 * Generate values for env vars that have generators.
 * Mutates the env record in place.
 */
export async function resolveGenerators(
	component: NormalizedComponent,
	env: Record<string, string>,
): Promise<void> {
	if (!component.env) return;

	for (const [key, envVar] of Object.entries(component.env)) {
		if (env[key] !== undefined) continue;
		if (envVar.generator) {
			env[key] = await generateValue(envVar.generator);
		}
	}
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
): Promise<Record<string, Record<string, string>>> {
	const allEnvs: Record<string, Record<string, string>> = {};
	const componentNames = Object.keys(launch.components);
	const isSingleComponent = componentNames.length === 1 && componentNames[0] === "default";

	for (const [name, component] of Object.entries(launch.components)) {
		const { env } = resolveComponentEnv(component, context, resourceMap);
		await resolveGenerators(component, env);

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
			await mkdir(envDir, { recursive: true });
			await writeEnvFile(join(envDir, `${name}.env`), env);
		}
	}

	return allEnvs;
}
