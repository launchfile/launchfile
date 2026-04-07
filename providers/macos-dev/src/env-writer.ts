/**
 * Environment variable resolver and writer.
 *
 * Connects provisioned resource properties to the SDK's expression resolver,
 * then writes the results to .env files.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	resolveExpression,
	isExpression,
	type NormalizedComponent,
	type NormalizedLaunch,
	type Secret,
} from "@launchfile/sdk";
import type { ResourceProperties } from "./resources/types.js";
import { generateValue } from "./secret-generator.js";

/**
 * Context for the SDK's resolveExpression().
 * Mirrors the interface from sdk/src/resolver.ts since it's not exported.
 */
export interface ResolverContext {
	resource?: Record<string, string | number>;
	resources?: Record<string, Record<string, string | number>>;
	components?: Record<string, Record<string, string | number>>;
	secrets?: Record<string, string>;
}

/**
 * Build a ResolverContext from provisioned resources, component ports, and secrets.
 */
export function buildResolverContext(
	resourceMap: Record<string, ResourceProperties>,
	componentPorts: Record<string, number>,
	secrets: Record<string, string>,
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

	return { resources, components, secrets };
}

/**
 * Resolve all environment variables for a single component.
 */
export function resolveComponentEnv(
	component: NormalizedComponent,
	context: ResolverContext,
	resourceMap: Record<string, ResourceProperties>,
): Record<string, string> {
	const env: Record<string, string> = {};

	// 1. Resolve set_env from requires
	for (const req of component.requires ?? []) {
		const resourceName = req.name ?? req.type;
		const props = resourceMap[resourceName];
		if (!req.set_env || !props) continue;

		// Build resource-scoped context (enclosing resource)
		const resourceRecord: Record<string, string | number> = {};
		for (const [k, v] of Object.entries(props)) {
			if (v !== undefined) resourceRecord[k] = v;
		}
		const scopedContext: ResolverContext = {
			...context,
			resource: resourceRecord,
		};

		for (const [envKey, expr] of Object.entries(req.set_env)) {
			env[envKey] = resolveExpression(expr, scopedContext);
		}
	}

	// 2. Resolve set_env from supports (only if resource was provisioned)
	for (const sup of component.supports ?? []) {
		const resourceName = sup.name ?? sup.type;
		const props = resourceMap[resourceName];
		if (!sup.set_env || !props) continue;

		const resourceRecord: Record<string, string | number> = {};
		for (const [k, v] of Object.entries(props)) {
			if (v !== undefined) resourceRecord[k] = v;
		}
		const scopedContext: ResolverContext = {
			...context,
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

			if (envVar.default !== undefined) {
				const defaultStr = String(envVar.default);
				if (isExpression(defaultStr)) {
					env[key] = resolveExpression(defaultStr, context);
				} else {
					env[key] = defaultStr;
				}
			}
			// required + no default + no generator → left unset (provider should prompt)
		}
	}

	return env;
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
			// Quote values that contain spaces, #, or newlines
			if (/[\s#\n]/.test(value)) {
				return `${key}="${value.replace(/"/g, '\\"')}"`;
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
		const env = resolveComponentEnv(component, context, resourceMap);
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
