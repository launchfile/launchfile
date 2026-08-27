/**
 * Launchfile → docker-compose.yml generator.
 *
 * Evolved from catalog/test/src/launch-to-compose.ts into a production-grade
 * compose generator. Generates proper secrets, named volumes, and stable
 * host port mappings.
 */

import { resolve as resolvePath } from "node:path";
import {
	isExpression,
	type NormalizedEnvVar,
	type NormalizedHealth,
	type NormalizedLaunch,
	type NormalizedRequirement,
	parseExpression,
	RESOURCE_PROPERTY_VOCABULARY,
	type ResolverContext,
	resolveExpression,
	unsuppliedRequiredEnv,
} from "@launchfile/sdk";
import { stringify } from "yaml";
import { computeAppProperties } from "./app-url.js";
import {
	registerSensitiveEnv,
	registerSuppliedEnv,
	registerSuppliedResourceProperties,
} from "./env-secrets.js";
import { publishedEndpoints } from "./port-allocator.js";
import { registerSecret } from "./redact.js";
import type { StateEndpoint } from "./state.js";

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
	const password = btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	registerSecret(password);
	return password;
}

function generateSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
	registerSecret(secret);
	return secret;
}

function generateUuid(): string {
	return crypto.randomUUID();
}

function generatePort(): string {
	// A `generator: port` value can be declared under `secrets:`, where it is
	// persisted to state and redacted like any other secret. Math.random() is
	// seeded predictably and is not a security primitive, so the port comes
	// from the same CSPRNG as every other generated value here.
	const range = 55_000;
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	// Reject the short final bucket so every port in the range is equally
	// likely — plain modulo would bias the low end.
	const limit = Math.floor(0x1_0000_0000 / range) * range;
	while (buf[0]! >= limit) crypto.getRandomValues(buf);
	return String(10_000 + (buf[0]! % range));
}

// --- requires.config handling ---

// Security: extension names come from Launchfile config (untrusted input).
// Validate each against SAFE_IDENTIFIER before interpolating into SQL —
// the same regex providers/macos-dev/src/resources/postgres.ts uses.
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// SPEC.md's `config.extensions` example lists package names (`pgvector`)
// while CREATE EXTENSION needs the SQL extension name (`vector`). Accept
// both spellings and normalize to the SQL name; names not listed here pass
// through unchanged.
const POSTGRES_EXTENSION_SQL_NAMES: Record<string, string> = {
	pgvector: "vector",
};

// SQL extension name → smallest stock image that ships its binaries. The
// default postgres image carries the contrib extensions (pg_trgm, hstore,
// citext, …) but not these; declaring one swaps the service image.
const POSTGRES_EXTENSION_IMAGES: Record<string, string> = {
	vector: "pgvector/pgvector:pg16",
	postgis: "postgis/postgis:16-3.4",
};

/**
 * Honor `requires.config` for postgres (PROVIDERS.md §10.8: report gaps,
 * not silent drops). Declared extensions select a satisfying image and are
 * created via an init script the caller mounts into
 * /docker-entrypoint-initdb.d/ (runs when the database directory is
 * initialized). An extension no known image provides passes through
 * validated — if the image lacks it, initialization fails loudly at boot
 * instead of the app failing later on its first CREATE EXTENSION. Every
 * config key or extension the provider cannot honor is surfaced as a
 * warning, never dropped.
 *
 * Returns the init SQL, or undefined when no extensions are declared.
 * Mutates `backing.image` when an extension requires a different image.
 */
function applyPostgresConfig(
	config: Record<string, unknown>,
	backing: BackingService,
	warnings: string[],
): string | undefined {
	const sqlNames: string[] = [];
	for (const [key, value] of Object.entries(config)) {
		if (key !== "extensions") {
			warnings.push(
				`postgres config key ${JSON.stringify(key)} is not supported by the docker provider — ignored`,
			);
			continue;
		}
		if (!Array.isArray(value)) {
			warnings.push("postgres config.extensions must be a list — ignored");
			continue;
		}
		for (const entry of value) {
			if (typeof entry !== "string" || !SAFE_IDENTIFIER.test(entry)) {
				warnings.push(
					`postgres extension name ${JSON.stringify(entry)} is not a valid identifier — skipped`,
				);
				continue;
			}
			const sqlName = POSTGRES_EXTENSION_SQL_NAMES[entry] ?? entry;
			if (!sqlNames.includes(sqlName)) sqlNames.push(sqlName);
		}
	}

	if (sqlNames.length === 0) return undefined;

	// First declared extension with a dedicated image picks the image;
	// contrib extensions keep the default image.
	const imageExts = sqlNames.filter((n) => POSTGRES_EXTENSION_IMAGES[n]);
	const first = imageExts[0];
	if (first) {
		backing.image = POSTGRES_EXTENSION_IMAGES[first]!;
		for (const other of imageExts.slice(1)) {
			warnings.push(
				`postgres extensions ${first} and ${other} need different images — selected ` +
					`${backing.image}; CREATE EXTENSION ${other} will fail at boot unless that image provides it`,
			);
		}
	}
	for (const ext of sqlNames) {
		if (POSTGRES_EXTENSION_IMAGES[ext]) continue;
		warnings.push(
			`postgres extension "${ext}" has no known dedicated image — passing it through; ` +
				`initialization fails at boot if ${backing.image} does not provide it`,
		);
	}

	return `${sqlNames.map((n) => `CREATE EXTENSION IF NOT EXISTS "${n}";`).join("\n")}\n`;
}

/**
 * Create a backing service factory with pre-generated or cached passwords.
 * Passwords are per-app to ensure consistency across restarts.
 *
 * Each factory's `properties` map is this provider's answer to SPEC.md
 * § Resource Property Vocabulary; `resourcePropertyKeys()` reads it back.
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
				// The image ships with no `requirepass`, so the honest value is empty.
				// The property is still exposed: SPEC.md § Resource Property Vocabulary
				// makes it a MUST for every provider that supports redis.
				password: "",
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
				// The image's shipped defaults: the `default` user with an empty
				// password. Reported as-is so the values match the deployment.
				user: "default",
				password: "",
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
				},
				healthcheck: {
					test: [
						"CMD-SHELL",
						`curl -sf -u elastic:$ELASTIC_PASSWORD http://localhost:9200/_cluster/health || exit 1`,
					],
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
					test: [
						"CMD-SHELL",
						"curl -sf http://localhost:9000/minio/health/live || exit 1",
					],
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
					test: [
						"CMD-SHELL",
						"curl -sf http://localhost:9000/minio/health/live || exit 1",
					],
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

/**
 * The property keys each supported backing-service type exposes, keyed by type.
 *
 * Derived by running the factories, not hand-listed: the conformance test
 * (`__tests__/resource-conformance.test.ts`) compares these against
 * `spec/schema/resource-properties.json`, and a hand-maintained copy would
 * drift from the factories, which is the drift the check exists to catch.
 *
 * Calling this generates throwaway passwords into a local secrets map. They are
 * never returned and never reach a compose file.
 */
export function resourcePropertyKeys(): Record<string, string[]> {
	const factories = createBackingServices({});
	const keys: Record<string, string[]> = {};
	for (const [type, factory] of Object.entries(factories)) {
		keys[type] = Object.keys(factory("probe").properties);
	}
	return keys;
}

// --- Main generator ---

export interface ComposeOpts {
	/** Pre-existing secrets to reuse (mutated with new secrets) */
	secrets?: Record<string, string>;
	/**
	 * Persisted `env:`-level generator values to reuse, keyed
	 * `<component>.<ENV_NAME>` (mutated with newly minted values).
	 */
	generatedEnv?: Record<string, string>;
	/** Host port overrides, keyed per `publishedEndpoints` (bare component name for the primary, `component:name` / `component:port` for the rest) */
	hostPorts?: Record<string, number>;
	/** Docker network name */
	networkName?: string;
	/** Project directory for local sources — relative `build:` contexts resolve against this */
	projectDir?: string;
	/**
	 * This provider's operator channel for `required:` variables the Launchfile
	 * itself supplies no value for (PROVIDERS.md §10 rule 8 — "obtain the value
	 * from its own operator-facing channel, or fail"). `dockerUp` passes
	 * `process.env`. Consulted ONLY for an otherwise-unsupplied required key:
	 * it never overrides a `default:`, a `generator:`, or a `set_env:` binding.
	 */
	operatorEnv?: Record<string, string | undefined>;
	/**
	 * Operator-supplied env values, keyed by component name then variable name
	 * (D-52). Every value is registered with the redactor before anything is
	 * generated, so an operator's credential cannot survive into captured output.
	 */
	supplied?: Record<string, Record<string, string>>;
	/**
	 * Operator-supplied host paths for `content: operator` volumes (D-50),
	 * keyed by volume name or `component.volume`. A key splits on its FIRST
	 * dot: if the left half names a component, the key is component-qualified;
	 * otherwise the whole key is a volume name (dots included). The qualified
	 * form wins when both match one volume. Values must be absolute — the
	 * compose file lives in state, not the project dir, so a relative path
	 * would rebase silently; `dockerUp` resolves flag values against its cwd
	 * and verifies each bound path exists before launching (rule 2 row 3).
	 */
	storagePaths?: Record<string, string>;
	/**
	 * Orchestrator-supplied publication context (#290): the public URL the app
	 * is reachable at when routing is owned OUTSIDE the compose project — a
	 * reverse proxy, tunnel, or edge in front of it. When set, `$app.*`
	 * resolves from this URL (D-33/D-35: url, host, port, authority, scheme,
	 * tls) instead of the provider's own `http://localhost:<hostPort>` routing
	 * answer. Published host ports are still allocated; they just aren't the
	 * public address.
	 *
	 * Asserts the public address of the app's PRIMARY endpoint only (the first
	 * `exposed: true` component — the existing `$app.*` contract). It MUST NOT
	 * be used to derive other published endpoints' public addresses;
	 * per-endpoint publication context is a separate future proposal.
	 *
	 * Must be an absolute http(s) URL with no userinfo, query, or fragment; a
	 * malformed value throws `InvalidAppUrlError` — refuse, never degrade.
	 * Unset preserves the current localhost behavior byte-for-byte.
	 */
	appUrl?: string;
	/**
	 * Orchestrator-satisfied `requires`/`supports` entries, keyed by the
	 * entry's `name ?? type` — app-global, matching the resource expression
	 * namespace (no component qualification). A supplied entry wins over this
	 * provider's own provisioning — always, including for types it has a
	 * factory for: no backing service, no `depends_on`, no volume, and no
	 * image pull are emitted for it. The entry's `set_env` resolves against
	 * the supplied `properties`, which speak the standard resource-property
	 * vocabulary (D-7/D-46). Suppression is per ENTRY, not per type: where
	 * two same-type entries exist and only one is supplied, the shared
	 * backing service is still emitted for the unsupplied one, and the
	 * supplied one takes its properties from this map. For `supports:`
	 * entries — which this provider never provisions on its own — a supplied
	 * entry is the only way their `set_env` bindings can ever inject.
	 *
	 * Readiness of the supplied resource is the orchestrator's precondition:
	 * with no backing service there is no `service_healthy` gate, and the
	 * provider does not verify the resource exists or is reachable — the
	 * orchestrator owns its channel's correctness (the D-50/D-52 posture).
	 * Credential-bearing values are registered with the redactor before
	 * anything is generated, so a supplied password cannot survive into
	 * captured output.
	 */
	resources?: Record<string, { properties: Record<string, string> }>;
}

/** A `content: operator` volume bound to an operator-supplied host path (D-50 row 1). */
export interface StorageBind {
	component: string;
	volume: string;
	/** The `storagePaths` key that supplied the path, as the operator wrote it. */
	key: string;
	hostPath: string;
	containerPath: string;
}

/** A `content: operator` volume no supplied path covers (D-50 row 2). */
export interface UnboundOperatorVolume {
	component: string;
	volume: string;
	/** The exact flag that satisfies the volume, e.g. `--storage music=<path>`. */
	flag: string;
}

/** A `required:` variable neither the Launchfile nor the operator supplied. */
export interface UnsuppliedRequiredVar {
	component: string;
	key: string;
	sensitive: boolean;
}

export interface ComposeResult {
	yaml: string;
	warnings: string[];
	/** Images to pull (services without a build config) */
	images: string[];
	/** Service names that must be built from a `build:` config before start */
	builds: string[];
	/** Secrets generated during composition (save to state) */
	secrets: Record<string, string>;
	/** `env:`-level generator values minted or reused during composition (save to state) */
	generatedEnv: Record<string, string>;
	/**
	 * Host port for every endpoint marked `exposed: true`, keyed per
	 * `publishedEndpoints`: bare component name for a component's first
	 * published endpoint, `component:name` / `component:port` for the rest.
	 * Persist the whole map — the allocator reuses it on the next `up`.
	 */
	ports: Record<string, number>;
	/** Endpoint metadata for each `ports` key (component, name, protocol) */
	endpoints: Record<string, StateEndpoint>;
	/** Map of component name → generated compose service name (skipped components absent) */
	services: Record<string, string>;
	/**
	 * `required:` variables that arrived from neither the Launchfile nor
	 * `opts.operatorEnv` (D-52, PROVIDERS.md §10 rule 8). Their keys are ABSENT
	 * from the emitted compose — never `""`, never a substitute.
	 *
	 * Deliberately NOT folded into `warnings`: `dockerUp` prints warnings and
	 * proceeds, which is precisely the warn-then-fail-anyway behavior D-52's
	 * *Rejected* block forbids. A deploying verb reads this field and fails.
	 * `launchToCompose` itself never throws for Launchfile content — it is
	 * exported public API and a pure generator. The one exception is a
	 * malformed `opts.appUrl`, an orchestrator input no `$app.*` can be
	 * correctly derived from: it throws `InvalidAppUrlError` before any
	 * generation (#290) — refuse, never degrade.
	 */
	unsuppliedRequired: UnsuppliedRequiredVar[];
	/**
	 * Bind mounts emitted for `content: operator` volumes (D-50 row 1). The
	 * generator is pure, so the caller owns row 3: verify each `hostPath`
	 * exists and is readable before launching — refuse, never create.
	 */
	storageBinds: StorageBind[];
	/**
	 * `content: operator` volumes with no supplied path (D-50 row 2). Their
	 * mounts are ABSENT from the emitted compose — never a fabricated empty
	 * volume. Same shape as `unsuppliedRequired`, deliberately NOT folded into
	 * `warnings`: a deploying verb reads this field and refuses.
	 */
	unboundOperatorVolumes: UnboundOperatorVolume[];
}

export function launchToCompose(
	launch: NormalizedLaunch,
	opts: ComposeOpts = {},
): ComposeResult {
	const warnings: string[] = [];
	const images: string[] = [];
	const builds: string[] = [];
	const services: Record<string, Record<string, unknown>> = {};
	const volumes: Record<string, Record<string, unknown>> = {};
	const configs: Record<string, Record<string, unknown>> = {};
	// serviceName → serialized req.config it was created with (shared-service dedup)
	const appliedConfigs = new Map<string, string>();
	const secrets = opts.secrets ?? {};
	const generatedEnv = opts.generatedEnv ?? {};
	const ports: Record<string, number> = {};
	const componentServices: Record<string, string> = {};
	const unsuppliedRequired: UnsuppliedRequiredVar[] = [];
	const endpoints: Record<string, StateEndpoint> = {};
	const storageBinds: StorageBind[] = [];
	const unboundOperatorVolumes: UnboundOperatorVolume[] = [];

	// D-50 storage-path keys, classified once against the component set: a key
	// whose first-dot left half names a component is component-qualified;
	// anything else — no dot, or a left half naming no component — is a bare
	// volume name, dots included.
	const componentSet = new Set(Object.keys(launch.components));
	const qualifiedPaths = new Map<string, { path: string; key: string }>();
	const barePaths = new Map<string, { path: string; key: string }>();
	for (const [key, path] of Object.entries(opts.storagePaths ?? {})) {
		const dot = key.indexOf(".");
		if (dot > 0 && componentSet.has(key.slice(0, dot))) {
			qualifiedPaths.set(key, { path, key });
		} else {
			barePaths.set(key, { path, key });
		}
	}
	const usedStorageKeys = new Set<string>();
	// How many components declare a volume of each name — an ambiguous name gets
	// the `component.volume` spelling in the refusal's suggested flag.
	const volumeNameCount = new Map<string, number>();
	for (const comp of Object.values(launch.components)) {
		for (const volName of Object.keys(comp.storage ?? {})) {
			volumeNameCount.set(volName, (volumeNameCount.get(volName) ?? 0) + 1);
		}
	}
	// Set by any component that declares `provides` and is actually translated,
	// so a component skipped earlier (refused capability, non-local build
	// context) can't be mistaken for a missing `exposed: true`.
	let declaredProvides = false;

	// Before anything resolves: every operator-supplied value is credential
	// material this provider never minted, so nothing else can have registered it
	// (D-52). Registering here covers components the generator later skips too.
	for (const values of Object.values(opts.supplied ?? {}))
		registerSuppliedEnv(values);

	// Same discipline for orchestrator-supplied resource properties: register
	// the credential-bearing ones before anything is generated or captured,
	// classified by name against the type's D-46 vocabulary (fail closed for
	// names outside it; the structural set stays unregistered so addresses and
	// ports never corrupt a diagnostic). The entry's declared type is looked up
	// across every component's requires/supports — the resource namespace is
	// app-global — and an unmatched key has no type, so all of its
	// non-structural properties register.
	if (opts.resources) {
		const suppliedResourceTypes = new Map<string, string>();
		for (const comp of Object.values(launch.components)) {
			for (const entry of [
				...(comp.requires ?? []),
				...(comp.supports ?? []),
			]) {
				if (entry.host) continue;
				suppliedResourceTypes.set(entry.name ?? entry.type, entry.type);
			}
		}
		for (const [key, resource] of Object.entries(opts.resources)) {
			const type = suppliedResourceTypes.get(key);
			registerSuppliedResourceProperties(
				resource.properties,
				type ? RESOURCE_PROPERTY_VOCABULARY[type] : undefined,
			);
		}
	}
	const usedResourceKeys = new Set<string>();

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

	// Compute $app.* properties (D-33) from the first component (in declaration
	// order) that has at least one `exposed: true` provides entry. The "primary"
	// component's host port is the app's externally-reachable port; the public
	// URL is http://localhost:<hostPort> — unless the orchestrator supplied the
	// publication context (`opts.appUrl`, #290), which answers instead. For
	// multi-exposed-component apps that need a specific component's URL, use
	// $components.<name>.url instead.
	const appProperties = computeAppProperties(launch, opts.hostPorts, opts.appUrl);

	const resolverContext: ResolverContext = {
		resources: resourceMap,
		components: componentMap,
		secrets,
		app: appProperties,
	};

	for (const [componentName, component] of Object.entries(launch.components)) {
		const serviceName =
			componentName === "default"
				? launch.name
				: `${launch.name}-${componentName}`;

		if (!component.image && !component.build) {
			warnings.push(`${componentName}: no image or build — skipped`);
			continue;
		}

		// Host capabilities — grant or refuse (D-44, PROVIDERS.md §11). This
		// provider grants none: handing an app the host's runtime socket, host
		// network, or privileged mode from inside a managed compose project
		// defeats its isolation model (and Docker-in-Docker is unreliable). A
		// required capability therefore REFUSES the component with a surfaced
		// message — never a silent drop. Both spellings are honored
		// equivalently: `host:`-marked requires entries and the legacy host
		// block. Optional (supports) capabilities are left ungranted with a
		// note so the degradation is visible.
		const refusedCapabilities: string[] = [];
		for (const req of component.requires ?? []) {
			if (!req.host) continue;
			for (const [capability, value] of Object.entries(req.host)) {
				refusedCapabilities.push(`${capability}=${String(value)}`);
			}
		}
		if (component.host?.docker === "required") {
			refusedCapabilities.push(
				"container_runtime=docker (host.docker: required)",
			);
		}
		if (component.host?.network === "host") {
			refusedCapabilities.push("network=host (host.network: host)");
		}
		if (component.host?.privileged) {
			refusedCapabilities.push("privileged=true (host.privileged)");
		}
		if (refusedCapabilities.length > 0) {
			warnings.push(
				`refused: ${componentName} requires host capabilities this provider cannot grant ` +
					`(${refusedCapabilities.join("; ")}) — component skipped`,
			);
			continue;
		}
		for (const sup of component.supports ?? []) {
			if (!sup.host) continue;
			for (const [capability, value] of Object.entries(sup.host)) {
				warnings.push(
					`${componentName}: optional host capability ${capability}=${String(value)} ` +
						"not granted — its set_env vars are omitted and the app runs degraded",
				);
			}
		}

		if (component.schedule) {
			warnings.push(
				`${componentName}: declares a schedule (\`${component.schedule}\`) — this provider will not run it on a timer; if the component does not schedule itself, the job will not run`,
			);
		}

		const service: Record<string, unknown> = {};

		if (component.build) {
			// Build from source. Relative contexts resolve against the project
			// directory (the compose file lives in state, not the project), so
			// `context: "."` means "the directory containing the Launchfile".
			// Remote contexts (git URLs) pass through — docker clones and builds
			// them itself, which keeps the build off the host for untrusted repos.
			const context = component.build.context ?? ".";
			const isRemoteContext = /^(https?:\/\/|git@|ssh:\/\/)/.test(context);
			if (!isRemoteContext && !opts.projectDir) {
				warnings.push(
					`${componentName}: build context "${context}" is relative but the source is not local — skipped`,
				);
				continue;
			}

			const build: Record<string, unknown> = {
				context: isRemoteContext
					? context
					: resolvePath(opts.projectDir!, context),
			};
			if (component.build.dockerfile)
				build.dockerfile = component.build.dockerfile;
			if (component.build.target) build.target = component.build.target;
			if (component.build.args) build.args = component.build.args;
			if (component.build.secrets?.length) {
				warnings.push(
					`${componentName}: build secrets are not yet supported by the docker provider — ignored`,
				);
			}
			service.build = build;
			// `image:` alongside `build:` names the built artifact (SPEC.md:
			// "build + image — image is the name/tag for the resulting artifact").
			if (component.image) service.image = component.image;
			builds.push(serviceName);
		} else {
			service.image = component.image;
			images.push(component.image!);
		}

		// Ports and endpoint registration
		if (component.provides?.length) {
			// Register component in resolver context for $components.name.prop
			// refs. This is the in-network address (compose service name +
			// container port), independent of D-27 host exposure — every declared
			// endpoint is reachable by sibling components, including one marked
			// `exposed: false`, which speaks to the host boundary and not to the
			// container network.
			const containerPort = component.provides[0]!.port;
			componentMap[componentName] = {
				url: `http://${serviceName}:${containerPort}`,
				host: serviceName,
				port: containerPort,
			};

			// Host publication: every endpoint marked `exposed: true` (D-27)
			// gets an explicit host:container mapping. A bare container port
			// would hand the choice to Docker, which picks a fresh random host
			// port on every recreate — so the endpoint moves and cannot be
			// linked to. Entries without `exposed: true` are never published.
			// A component that publishes nothing is the normal shape for an
			// internal service (D-27: "Only the frontend or API gateway should be
			// publicly reachable"), so it is not worth a warning on its own. The
			// app-level check after this loop catches the case that actually
			// leaves the user stranded.
			declaredProvides = true;
			const published = publishedEndpoints(componentName, component.provides);
			if (published.length > 0) {
				const seen = new Set<string>();
				const mappings: string[] = [];
				for (const endpoint of published) {
					const hostPort = opts.hostPorts?.[endpoint.key] ?? endpoint.port;
					ports[endpoint.key] = hostPort;
					endpoints[endpoint.key] = {
						component: componentName,
						name: endpoint.name,
						containerPort: endpoint.port,
						hostPort,
						protocol: endpoint.protocol,
					};
					const bind =
						endpoint.bind && endpoint.bind !== "0.0.0.0"
							? `${endpoint.bind}:`
							: "";
					const proto = endpoint.protocol === "udp" ? "/udp" : "";
					const mapping = `${bind}${hostPort}:${endpoint.port}${proto}`;
					// Two entries can only produce the same mapping string when no
					// allocator ran (fallback host port = container port); compose
					// rejects duplicates, so emit each mapping once.
					if (seen.has(mapping)) continue;
					seen.add(mapping);
					mappings.push(mapping);
				}
				service.ports = mappings;
			}
		}

		// Provider-resolved storage paths (D-39). Docker bind-mounts each named
		// volume at its declared `path`, so `$storage.<name>.path` resolves to that
		// in-container path. Scoped per component (volume names are component-local).
		const componentContext: ResolverContext = component.storage
			? {
					...resolverContext,
					storage: Object.fromEntries(
						Object.entries(component.storage).map(([volName, vol]) => [
							volName,
							{ path: vol.path },
						]),
					),
				}
			: resolverContext;

		// Environment variables
		const env: Record<string, string> = {};

		if (component.env) {
			for (const [key, envVar] of Object.entries(component.env)) {
				const value = resolveEnvVar(
					envVar,
					componentContext,
					key,
					componentName,
					generatedEnv,
				);
				if (value !== undefined) {
					env[key] = value;
				}
			}
		}

		// Backing services from requires
		const dependsOn: Record<string, { condition: string }> = {};

		// One satisfied entry, requires or supports: register the supplied
		// properties for cross-resource resolution and inject its set_env —
		// no service, no depends_on, no volume, no pull. Config on a resource
		// this provider does not own cannot be applied and is surfaced (§10.8),
		// and a referenced-but-unsupplied property warns before resolving ""
		// (L-4) so an integration gap on this external channel is never silent.
		const applySuppliedResource = (
			entry: NormalizedRequirement,
			resourceName: string,
			properties: Record<string, string>,
		): void => {
			usedResourceKeys.add(resourceName);
			resourceMap[resourceName] = { ...properties };
			if (entry.config) {
				warnings.push(
					`${componentName}: config on ${resourceName} cannot be applied — the resource is orchestrator-supplied, not provisioned by this provider — ignored`,
				);
			}
			if (entry.set_env) {
				const scopedContext: ResolverContext = {
					...componentContext,
					resource: properties,
				};
				for (const [envKey, expr] of Object.entries(entry.set_env)) {
					for (const prop of missingSuppliedRefs(
						expr,
						resourceName,
						properties,
					)) {
						warnings.push(
							`${componentName}: set_env references ${resourceName}.${prop}, which the supplied resource does not provide — resolved to ""`,
						);
					}
					env[envKey] = resolveExpression(expr, scopedContext);
				}
			}
		};

		if (component.requires?.length) {
			for (const req of component.requires) {
				const resourceName = req.name ?? req.type;
				const suppliedResource = opts.resources?.[resourceName];
				if (suppliedResource) {
					// The supplied entry wins over factory dispatch — always,
					// including for types this provider could provision itself
					// (the D-43 rule 1 precedence). Satisfaction is per entry:
					// a same-type entry under another key still provisions.
					// Readiness of a resource this provider does not manage is
					// the orchestrator's precondition — compose cannot
					// healthcheck a service it does not own (D-16 orders
					// startup only within the project), so no gate is emitted.
					applySuppliedResource(req, resourceName, suppliedResource.properties);
					continue;
				}
				const backingResult = addBackingService(
					launch.name,
					req,
					services,
					volumes,
					configs,
					appliedConfigs,
					images,
					warnings,
					backingServices,
				);
				if (backingResult) {
					// Register this resource's properties for cross-resource resolution
					resourceMap[resourceName] = backingResult.properties;

					if (req.set_env) {
						// Build scoped context with enclosing resource for $prop resolution
						const scopedContext: ResolverContext = {
							...componentContext,
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

		// Optional resources (`supports:`) — this provider never provisions
		// them, so an orchestrator-supplied entry is the only way their
		// set_env bindings can ever inject. An unsatisfied entry keeps its
		// long-standing behavior — nothing injected — but warns so the
		// degradation is visible (§10.8), matching the ungranted
		// host-capability note above. Host-marked entries are capabilities
		// (grant/refuse, D-53), already handled at the top of this loop.
		for (const sup of component.supports ?? []) {
			if (sup.host) continue;
			const resourceName = sup.name ?? sup.type;
			const suppliedResource = opts.resources?.[resourceName];
			if (!suppliedResource) {
				warnings.push(
					`${componentName}: optional resource ${resourceName} is not satisfied — this provider does not provision \`supports:\` resources and none was supplied; its set_env bindings are omitted and the app runs degraded`,
				);
				continue;
			}
			applySuppliedResource(sup, resourceName, suppliedResource.properties);
		}

		// Unsupplied `required:` variables (D-52, PROVIDERS.md §10 rule 8). This
		// runs AFTER the `set_env` injection above because the test is arrival:
		// a binding counts only when the resource behind it resolved —
		// provisioned by this provider or satisfied through `opts.resources`.
		// An unsatisfied `supports:` binding, and a binding on an unknown,
		// unsupplied backing type, never inject, so neither reaches `env` here.
		// Whatever is still missing gets one look at the operator channel, then
		// is recorded — absent from the artifact, never substituted.
		for (const { key, sensitive } of unsuppliedRequiredEnv(
			component,
			Object.keys(env),
		)) {
			const supplied = opts.operatorEnv?.[key];
			if (supplied !== undefined) {
				env[key] = supplied;
				continue;
			}
			unsuppliedRequired.push({ component: componentName, key, sensitive });
		}

		// Inter-component depends_on
		if (component.depends_on?.length) {
			for (const dep of component.depends_on) {
				const depServiceName =
					dep.component === "default"
						? launch.name
						: `${launch.name}-${dep.component}`;
				dependsOn[depServiceName] = {
					condition:
						dep.condition === "healthy" ? "service_healthy" : "service_started",
				};
			}
		}

		// Register the credential-bearing values this provider did not mint —
		// author-declared `sensitive: true` literals (D-18) and anything the
		// operator supplied (D-52) — before any of them can reach a log line, an
		// echoed command, or a captured failure record (CWE-532).
		registerSensitiveEnv(component.env, env);

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
			service.healthcheck = translateHealth(
				component.health,
				component.provides,
			);
		}

		// Storage — named volumes for persistence. A `content: operator` volume
		// (D-50) is instead bound to the operator-supplied host path, or — when
		// no path covers it — its mount is withheld and the volume recorded for
		// the caller to refuse: an empty named volume where the operator's
		// content belongs is D-52's fabrication in storage form. An unmarked
		// volume is untouched by `storagePaths` (row 4: byte-identical).
		if (component.storage) {
			const svcVolumes: string[] = [];
			for (const [volName, vol] of Object.entries(component.storage)) {
				if (vol.content === "operator") {
					const bound =
						qualifiedPaths.get(`${componentName}.${volName}`) ??
						barePaths.get(volName);
					if (!bound) {
						const flagKey =
							(volumeNameCount.get(volName) ?? 0) > 1
								? `${componentName}.${volName}`
								: volName;
						unboundOperatorVolumes.push({
							component: componentName,
							volume: volName,
							flag: `--storage ${flagKey}=<path>`,
						});
						continue;
					}
					usedStorageKeys.add(bound.key);
					svcVolumes.push(`${bound.path}:${vol.path}`);
					storageBinds.push({
						component: componentName,
						volume: volName,
						key: bound.key,
						hostPath: bound.path,
						containerPath: vol.path,
					});
					continue;
				}
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
		componentServices[componentName] = serviceName;
	}

	// Nothing anywhere in the app reaches the host, so `launchfile up` would
	// report success on an app the user cannot open and `$app.url` resolves to
	// "". Per-component silence is correct (internal services are the norm);
	// this is the case that needs saying out loud (P-4, D-27).
	if (declaredProvides && Object.keys(ports).length === 0) {
		warnings.push(
			`${launch.name}: no endpoint sets \`exposed: true\` — nothing is published to the host, so the app is not reachable (D-27)`,
		);
	}

	// A storage-path key that bound nothing would otherwise vanish without a
	// trace — a typo'd name surfaces here (the unbound marked volume it left
	// behind is refused separately, so this alone never masks a refusal). Only
	// `content: operator` volumes are bindable: row 4 keeps unmarked volumes
	// byte-identical, so a key naming one is unused too.
	for (const key of Object.keys(opts.storagePaths ?? {})) {
		if (!usedStorageKeys.has(key)) {
			warnings.push(
				`--storage ${key} matches no \`content: operator\` volume — ignored`,
			);
		}
	}

	// Same sweep for the supplied-resource channel: a key that satisfied no
	// `requires`/`supports` entry would otherwise vanish without a trace, and a
	// typo'd key surfaces here. Its properties were still registered with the
	// redactor above — an unmatched credential is a credential all the same.
	for (const key of Object.keys(opts.resources ?? {})) {
		if (!usedResourceKeys.has(key)) {
			warnings.push(
				`supplied resource ${key} matches no \`requires\`/\`supports\` entry — ignored`,
			);
		}
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
	if (Object.keys(configs).length > 0) {
		compose.configs = configs;
	}

	return {
		yaml: stringify(compose, { lineWidth: 120 }),
		warnings,
		images: [...new Set(images)],
		builds,
		secrets,
		generatedEnv,
		ports,
		endpoints,
		services: componentServices,
		unsuppliedRequired,
		storageBinds,
		unboundOperatorVolumes,
	};
}

// --- Helpers ---

/** Multi-segment namespaces the resolver checks before user-named resources. */
const RESERVED_NAMESPACES = new Set([
	"app",
	"secrets",
	"components",
	"storage",
]);

/**
 * The properties a `set_env` expression reads from THIS supplied resource that
 * its property map does not provide. Counted: scoped `$prop` references and
 * `$<resourceName>.<prop>` references; not counted: reserved namespaces, other
 * resources, and any reference carrying a `:-fallback` — the fallback fires
 * instead of the empty resolution this warning exists to flag.
 */
function missingSuppliedRefs(
	expr: string,
	resourceName: string,
	properties: Record<string, string>,
): string[] {
	const parsed = parseExpression(expr);
	const refs: Array<{ path: string[]; fallback?: string }> = [];
	if (parsed.kind === "reference") {
		refs.push(parsed);
	} else if (parsed.kind === "template") {
		for (const part of parsed.parts) {
			if (part.kind === "ref") refs.push(part);
		}
	}

	const missing: string[] = [];
	for (const ref of refs) {
		if (ref.fallback !== undefined) continue;
		let prop: string | undefined;
		if (ref.path.length === 1) {
			prop = ref.path[0];
		} else if (
			ref.path.length === 2 &&
			ref.path[0] === resourceName &&
			!RESERVED_NAMESPACES.has(resourceName)
		) {
			prop = ref.path[1];
		}
		if (
			prop !== undefined &&
			!(prop in properties) &&
			!missing.includes(prop)
		) {
			missing.push(prop);
		}
	}
	return missing;
}

function resolveEnvVar(
	envVar: NormalizedEnvVar,
	context: ResolverContext,
	key: string,
	componentName: string,
	generatedEnv: Record<string, string>,
): string | undefined {
	if (envVar.generator) {
		// `port` is exempt from preservation (D-49): ports are re-allocated
		// each run, and a preserved port produces a bind conflict rather than
		// continuity.
		if (envVar.generator === "port") return generatePort();

		// Minted values are preserved (D-49): reuse the value state holds,
		// mint and record otherwise. Keyed per declaration
		// (`<component>.<ENV_NAME>`, D-25) — never by bare variable name — so
		// same-named variables on different components stay independent, and
		// kept out of `secrets` so these names never resolve as
		// `$secrets.<name>`.
		const stateKey = `${componentName}.${key}`;
		const existing = generatedEnv[stateKey];
		if (existing !== undefined) return existing;
		const value =
			envVar.generator === "secret" ? generateSecret() : generateUuid();
		generatedEnv[stateKey] = value;
		return value;
	}

	if (envVar.default !== undefined) {
		const val = String(envVar.default);
		if (isExpression(val)) {
			return resolveExpression(val, context);
		}
		return val;
	}

	// A `required:` var the file supplies no value for gets NO value here — the
	// key stays absent from the service's `environment:` map (D-52, PROVIDERS.md
	// §10 rule 8). `launchToCompose` records it in `unsuppliedRequired` and
	// `dockerUp` fails on it by name.
	return undefined;
}

function addBackingService(
	appName: string,
	req: NormalizedRequirement,
	services: Record<string, Record<string, unknown>>,
	volumes: Record<string, Record<string, unknown>>,
	configs: Record<string, Record<string, unknown>>,
	appliedConfigs: Map<string, string>,
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

	if (services[serviceName]) {
		// The backing service is shared across components; only the requirement
		// that created it configured it. A later requirement whose config
		// matches is already satisfied; a differing one cannot be honored and
		// must be surfaced (§10.8) — never silently dropped. The comparison is
		// on serialized form, so key order matters; a false mismatch costs a
		// warning, never a behavior change.
		const incoming = JSON.stringify(req.config ?? null);
		if (incoming !== appliedConfigs.get(serviceName)) {
			warnings.push(
				`${type} config on a later requirement differs from what the shared service ` +
					`${serviceName} was created with — ignored (the first requirement wins)`,
			);
		}
	} else {
		const backing = factory(appName);
		appliedConfigs.set(serviceName, JSON.stringify(req.config ?? null));

		// requires.config — honor what we can, surface what we can't (§10.8).
		let initSql: string | undefined;
		if (req.config) {
			if (type === "postgres") {
				initSql = applyPostgresConfig(req.config, backing, warnings);
			} else {
				for (const key of Object.keys(req.config)) {
					warnings.push(
						`${type} config key ${JSON.stringify(key)} is not supported by the docker provider — ignored`,
					);
				}
			}
		}

		images.push(backing.image);

		const service: Record<string, unknown> = {
			image: backing.image,
		};

		if (initSql) {
			// Inline compose config (Compose v2.23.0+) — keeps the init script
			// inside the generated file, no sidecar to write or clean up.
			const configName = `${serviceName}-init`;
			configs[configName] = { content: initSql };
			service.configs = [
				{
					source: configName,
					target: "/docker-entrypoint-initdb.d/90-launchfile-extensions.sql",
				},
			];
		}

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
