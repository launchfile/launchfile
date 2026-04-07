/**
 * Launchfile → docker-compose.yml generator.
 *
 * Evolved from catalog/test/src/launch-to-compose.ts into a production-grade
 * compose generator. Generates proper secrets, named volumes, and stable
 * host port mappings.
 */

import { stringify } from "yaml";
import {
	resolveExpression,
	isExpression,
	type ResolverContext,
	type NormalizedLaunch,
	type NormalizedRequirement,
	type NormalizedEnvVar,
	type NormalizedHealth,
} from "@launchfile/sdk";

// --- Backing service definitions ---

interface BackingService {
	image: string;
	environment: Record<string, string>;
	properties: Record<string, string>;
	healthcheck?: ComposeHealthcheck;
	extra?: Record<string, unknown>;
}

interface ComposeHealthcheck {
	test: string[];
	interval: string;
	timeout: string;
	retries: number;
	start_period?: string;
}

function randomPassword(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	// Base64url encoding — safe for URLs and env vars
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function generateSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function generateUuid(): string {
	return crypto.randomUUID();
}

function generatePort(): string {
	return String(10000 + Math.floor(Math.random() * 55000));
}

/**
 * Create a backing service factory with pre-generated or cached passwords.
 * Passwords are per-app to ensure consistency across restarts.
 */
function createBackingServices(
	savedSecrets: Record<string, string>,
): Record<string, (name: string) => BackingService> {
	// Use saved password or generate a new one
	const getPassword = (key: string): string => {
		if (savedSecrets[key]) return savedSecrets[key]!;
		const pw = randomPassword();
		savedSecrets[key] = pw;
		return pw;
	};

	return {
		postgres: (name) => {
			const pw = getPassword("postgres");
			return {
				image: "postgres:16-alpine",
				environment: {
					POSTGRES_USER: "launchfile",
					POSTGRES_PASSWORD: pw,
					POSTGRES_DB: name,
				},
				properties: {
					host: `${name}-postgres`,
					port: "5432",
					user: "launchfile",
					password: pw,
					name: name,
					url: `postgres://launchfile:${encodeURIComponent(pw)}@${name}-postgres:5432/${name}?sslmode=disable`,
				},
				healthcheck: {
					test: ["CMD-SHELL", `pg_isready -U launchfile -d ${name}`],
					interval: "5s",
					timeout: "5s",
					retries: 5,
				},
			};
		},

		mysql: (name) => {
			const pw = getPassword("mysql");
			return {
				image: "mysql:8",
				environment: {
					MYSQL_ROOT_PASSWORD: pw,
					MYSQL_USER: "launchfile",
					MYSQL_PASSWORD: pw,
					MYSQL_DATABASE: name,
				},
				properties: {
					host: `${name}-mysql`,
					port: "3306",
					user: "launchfile",
					password: pw,
					name: name,
					url: `mysql://launchfile:${encodeURIComponent(pw)}@${name}-mysql:3306/${name}`,
				},
				healthcheck: {
					test: ["CMD", "mysqladmin", "ping", "-h", "localhost"],
					interval: "5s",
					timeout: "5s",
					retries: 5,
				},
			};
		},

		mariadb: (name) => {
			const pw = getPassword("mariadb");
			return {
				image: "mariadb:11",
				environment: {
					MARIADB_ROOT_PASSWORD: pw,
					MARIADB_USER: "launchfile",
					MARIADB_PASSWORD: pw,
					MARIADB_DATABASE: name,
				},
				properties: {
					host: `${name}-mariadb`,
					port: "3306",
					user: "launchfile",
					password: pw,
					name: name,
					url: `mysql://launchfile:${encodeURIComponent(pw)}@${name}-mariadb:3306/${name}`,
				},
				healthcheck: {
					test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"],
					interval: "5s",
					timeout: "5s",
					retries: 5,
				},
			};
		},

		redis: (_name) => ({
			image: "redis:7-alpine",
			environment: {},
			properties: {
				host: `${_name}-redis`,
				port: "6379",
				url: `redis://${_name}-redis:6379`,
			},
			healthcheck: {
				test: ["CMD", "redis-cli", "ping"],
				interval: "5s",
				timeout: "5s",
				retries: 5,
			},
		}),

		mongodb: (name) => {
			const pw = getPassword("mongodb");
			return {
				image: "mongo:7",
				environment: {
					MONGO_INITDB_ROOT_USERNAME: "launchfile",
					MONGO_INITDB_ROOT_PASSWORD: pw,
				},
				properties: {
					host: `${name}-mongodb`,
					port: "27017",
					user: "launchfile",
					password: pw,
					name: name,
					url: `mongodb://launchfile:${encodeURIComponent(pw)}@${name}-mongodb:27017/${name}?authSource=admin`,
				},
				healthcheck: {
					test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"],
					interval: "5s",
					timeout: "5s",
					retries: 5,
				},
			};
		},

		clickhouse: (name) => ({
			image: "clickhouse/clickhouse-server:latest",
			environment: {},
			properties: {
				host: `${name}-clickhouse`,
				port: "8123",
				url: `http://${name}-clickhouse:8123`,
				name: name,
			},
			healthcheck: {
				test: ["CMD-SHELL", "wget --spider -q http://localhost:8123/ping"],
				interval: "5s",
				timeout: "5s",
				retries: 5,
			},
		}),

		elasticsearch: (name) => {
			// Security: enable xpack security with generated credentials.
			// Previously disabled by default, exposing unauthenticated API access.
			const pw = getPassword("elasticsearch");
			return {
				image: "elasticsearch:8.17.0",
				environment: {
					"discovery.type": "single-node",
					"xpack.security.enabled": "true",
					ELASTIC_PASSWORD: pw,
				},
				properties: {
					host: `${name}-elasticsearch`,
					port: "9200",
					user: "elastic",
					password: pw,
					url: `http://elastic:${encodeURIComponent(pw)}@${name}-elasticsearch:9200`,
					name: name,
				},
				healthcheck: {
					test: ["CMD-SHELL", `curl -sf -u elastic:$ELASTIC_PASSWORD http://localhost:9200/_cluster/health || exit 1`],
					interval: "10s",
					timeout: "5s",
					retries: 5,
					start_period: "30s",
				},
			};
		},

		minio: (name) => {
			const accessKey = getPassword("minio-access");
			const secretKey = getPassword("minio-secret");
			return {
				image: "minio/minio:latest",
				environment: {
					MINIO_ROOT_USER: accessKey,
					MINIO_ROOT_PASSWORD: secretKey,
				},
				properties: {
					host: `${name}-minio`,
					port: "9000",
					url: `http://${name}-minio:9000`,
					access_key: accessKey,
					secret_key: secretKey,
					bucket: name,
					region: "us-east-1",
				},
				extra: {
					command: "server /data",
				},
				healthcheck: {
					test: ["CMD-SHELL", "curl -sf http://localhost:9000/minio/health/live || exit 1"],
					interval: "10s",
					timeout: "5s",
					retries: 5,
				},
			};
		},

		s3: (name) => {
			const accessKey = getPassword("s3-access");
			const secretKey = getPassword("s3-secret");
			return {
				image: "minio/minio:latest",
				environment: {
					MINIO_ROOT_USER: accessKey,
					MINIO_ROOT_PASSWORD: secretKey,
				},
				properties: {
					host: `${name}-s3`,
					port: "9000",
					url: `http://${name}-s3:9000`,
					access_key: accessKey,
					secret_key: secretKey,
					bucket: name,
					region: "us-east-1",
				},
				extra: {
					command: "server /data",
				},
				healthcheck: {
					test: ["CMD-SHELL", "curl -sf http://localhost:9000/minio/health/live || exit 1"],
					interval: "10s",
					timeout: "5s",
					retries: 5,
				},
			};
		},

		memcache: (_name) => ({
			image: "memcached:1-alpine",
			environment: {},
			properties: {
				host: `${_name}-memcache`,
				port: "11211",
				url: `${_name}-memcache:11211`,
			},
			healthcheck: {
				test: ["CMD-SHELL", "echo stats | nc localhost 11211 | grep -q pid"],
				interval: "5s",
				timeout: "5s",
				retries: 5,
			},
		}),

		rabbitmq: (name) => {
			// Security: generate credentials instead of using default guest:guest,
			// which is well-known and has full admin access.
			const pw = getPassword("rabbitmq");
			return {
				image: "rabbitmq:3-alpine",
				environment: {
					RABBITMQ_DEFAULT_USER: "launchfile",
					RABBITMQ_DEFAULT_PASS: pw,
				},
				properties: {
					host: `${name}-rabbitmq`,
					port: "5672",
					user: "launchfile",
					password: pw,
					url: `amqp://launchfile:${encodeURIComponent(pw)}@${name}-rabbitmq:5672`,
				},
				healthcheck: {
					test: ["CMD", "rabbitmq-diagnostics", "check_port_connectivity"],
					interval: "10s",
					timeout: "5s",
					retries: 5,
					start_period: "30s",
				},
			};
		},
	};
}

// --- Main generator ---

export interface ComposeOpts {
	/** Pre-existing secrets to reuse (mutated with new secrets) */
	secrets?: Record<string, string>;
	/** Host port overrides, keyed by component name */
	hostPorts?: Record<string, number>;
	/** Docker network name */
	networkName?: string;
}

export interface ComposeResult {
	yaml: string;
	warnings: string[];
	images: string[];
	/** Secrets generated during composition (save to state) */
	secrets: Record<string, string>;
	/** Map of component name → exposed host port */
	ports: Record<string, number>;
}

export function launchToCompose(
	launch: NormalizedLaunch,
	opts: ComposeOpts = {},
): ComposeResult {
	const warnings: string[] = [];
	const images: string[] = [];
	const services: Record<string, Record<string, unknown>> = {};
	const volumes: Record<string, Record<string, unknown>> = {};
	const secrets = opts.secrets ?? {};
	const ports: Record<string, number> = {};

	const backingServices = createBackingServices(secrets);

	// Pre-generate app-wide secrets
	if (launch.secrets) {
		for (const [name, secret] of Object.entries(launch.secrets)) {
			if (secrets[name]) continue; // Already saved
			if (secret.generator === "secret") secrets[name] = generateSecret();
			else if (secret.generator === "uuid") secrets[name] = generateUuid();
			else if (secret.generator === "port") secrets[name] = generatePort();
		}
	}

	// Build resolver context — populated as backing services and components are processed
	const resourceMap: Record<string, Record<string, string | number>> = {};
	const componentMap: Record<string, Record<string, string | number>> = {};
	const resolverContext: ResolverContext = {
		resources: resourceMap,
		components: componentMap,
		secrets,
	};

	for (const [componentName, component] of Object.entries(launch.components)) {
		const serviceName =
			componentName === "default" ? launch.name : `${launch.name}-${componentName}`;

		if (!component.image) {
			if (component.build) {
				warnings.push(`${componentName}: uses build — skipped (no image)`);
				continue;
			}
			warnings.push(`${componentName}: no image or build — skipped`);
			continue;
		}

		if (component.host?.docker === "required") {
			warnings.push(`${componentName}: requires Docker socket — skipped`);
			continue;
		}
		if (component.host?.network === "host") {
			warnings.push(`${componentName}: requires host networking — skipped`);
			continue;
		}
		if (component.host?.privileged) {
			warnings.push(`${componentName}: requires privileged mode — skipped`);
			continue;
		}

		if (component.schedule) {
			warnings.push(`${componentName}: has schedule — included but won't cron`);
		}

		images.push(component.image);

		const service: Record<string, unknown> = {
			image: component.image,
		};

		// Ports — map to specific host ports
		if (component.provides?.length) {
			const exposed = component.provides.filter((p) => p.exposed !== false);
			if (exposed.length > 0) {
				const hostPort = opts.hostPorts?.[componentName] ?? exposed[0]!.port;
				service.ports = exposed.map((p) =>
					p === exposed[0] ? `${hostPort}:${p.port}` : `${p.port}`,
				);
				ports[componentName] = hostPort;

				// Register component in resolver context for $components.name.prop refs
				const containerPort = exposed[0]!.port;
				componentMap[componentName] = {
					url: `http://${serviceName}:${containerPort}`,
					host: serviceName,
					port: containerPort,
				};
			}
		}

		// Environment variables
		const env: Record<string, string> = {};

		if (component.env) {
			for (const [key, envVar] of Object.entries(component.env)) {
				const value = resolveEnvVar(envVar, resolverContext, key);
				if (value !== undefined) {
					env[key] = value;
				}
			}
		}

		// Backing services from requires
		const dependsOn: Record<string, { condition: string }> = {};

		if (component.requires?.length) {
			for (const req of component.requires) {
				const backingResult = addBackingService(
					launch.name,
					req,
					services,
					volumes,
					images,
					warnings,
					backingServices,
				);
				if (backingResult) {
					// Register this resource's properties for cross-resource resolution
					const resourceName = req.name ?? req.type;
					resourceMap[resourceName] = backingResult.properties;

					if (req.set_env) {
						// Build scoped context with enclosing resource for $prop resolution
						const scopedContext: ResolverContext = {
							...resolverContext,
							resource: backingResult.properties,
						};
						for (const [envKey, expr] of Object.entries(req.set_env)) {
							env[envKey] = resolveExpression(expr, scopedContext);
						}
					}
					dependsOn[backingResult.serviceName] = {
						condition: "service_healthy",
					};
				}
			}
		}

		// Inter-component depends_on
		if (component.depends_on?.length) {
			for (const dep of component.depends_on) {
				const depServiceName =
					dep.component === "default"
						? launch.name
						: `${launch.name}-${dep.component}`;
				dependsOn[depServiceName] = {
					condition: dep.condition === "healthy" ? "service_healthy" : "service_started",
				};
			}
		}

		if (Object.keys(env).length > 0) {
			service.environment = env;
		}

		if (Object.keys(dependsOn).length > 0) {
			service.depends_on = dependsOn;
		}

		if (component.commands?.start) {
			service.command = component.commands.start.command;
		}

		if (component.health) {
			service.healthcheck = translateHealth(component.health, component.provides);
		}

		// Storage — named volumes for persistence
		if (component.storage) {
			const svcVolumes: string[] = [];
			for (const [volName, vol] of Object.entries(component.storage)) {
				const namedVolume = `${serviceName}-${volName}`;
				svcVolumes.push(`${namedVolume}:${vol.path}`);
				volumes[namedVolume] = {};
			}
			if (svcVolumes.length > 0) {
				service.volumes = svcVolumes;
			}
		}

		if (component.restart) {
			service.restart = component.restart;
		} else {
			service.restart = "unless-stopped";
		}

		services[serviceName] = service;
	}

	// Add network
	const networkName = opts.networkName ?? `launchfile-${launch.name}-net`;
	for (const service of Object.values(services)) {
		service.networks = [networkName];
	}

	const compose: Record<string, unknown> = {
		services,
		networks: { [networkName]: { driver: "bridge" } },
	};
	if (Object.keys(volumes).length > 0) {
		compose.volumes = volumes;
	}

	return {
		yaml: stringify(compose, { lineWidth: 120 }),
		warnings,
		images: [...new Set(images)],
		secrets,
		ports,
	};
}

// --- Helpers ---

function resolveEnvVar(
	envVar: NormalizedEnvVar,
	context: ResolverContext,
	key?: string,
): string | undefined {
	if (envVar.generator) {
		if (envVar.generator === "secret") return generateSecret();
		if (envVar.generator === "uuid") return generateUuid();
		if (envVar.generator === "port") return generatePort();
	}

	if (envVar.default !== undefined) {
		const val = String(envVar.default);
		if (isExpression(val)) {
			return resolveExpression(val, context);
		}
		return val;
	}

	if (envVar.required) {
		const lowerKey = key?.toLowerCase() ?? "";
		if (lowerKey.includes("url") || lowerKey.includes("domain") || lowerKey.includes("origin")) {
			return "http://localhost";
		}
		if (lowerKey.includes("email") || lowerKey.includes("mail")) {
			return "test@localhost";
		}
		return "PLACEHOLDER";
	}

	return undefined;
}

function addBackingService(
	appName: string,
	req: NormalizedRequirement,
	services: Record<string, Record<string, unknown>>,
	volumes: Record<string, Record<string, unknown>>,
	images: string[],
	warnings: string[],
	backingServices: Record<string, (name: string) => BackingService>,
): { serviceName: string; properties: Record<string, string> } | null {
	const type = req.type;
	const factory = backingServices[type];

	if (!factory) {
		warnings.push(`Unknown backing service type: ${type} — skipped`);
		return null;
	}

	const serviceName = `${appName}-${type}`;

	if (!services[serviceName]) {
		const backing = factory(appName);
		images.push(backing.image);

		const service: Record<string, unknown> = {
			image: backing.image,
		};

		if (Object.keys(backing.environment).length > 0) {
			service.environment = backing.environment;
		}

		if (backing.healthcheck) {
			service.healthcheck = backing.healthcheck;
		}

		if (backing.extra) {
			Object.assign(service, backing.extra);
		}

		const volName = `${serviceName}-data`;
		service.volumes = [`${volName}:/data`];
		volumes[volName] = {};

		services[serviceName] = service;
	}

	return {
		serviceName,
		properties: factory(appName).properties,
	};
}

function translateHealth(
	health: NormalizedHealth,
	provides?: { port: number; protocol: string }[],
): ComposeHealthcheck {
	if (health.command) {
		return {
			test: ["CMD-SHELL", health.command],
			interval: health.interval ?? "10s",
			timeout: health.timeout ?? "5s",
			retries: health.retries ?? 3,
			start_period: health.start_period ?? "30s",
		};
	}

	const port = provides?.[0]?.port ?? 80;
	const path = health.path ?? "/";

	return {
		test: [
			"CMD-SHELL",
			`wget -qO /dev/null http://localhost:${port}${path} || curl -sf http://localhost:${port}${path} > /dev/null || exit 1`,
		],
		interval: health.interval ?? "10s",
		timeout: health.timeout ?? "5s",
		retries: health.retries ?? 5,
		start_period: health.start_period ?? "60s",
	};
}
