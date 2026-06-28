/**
 * Launchfile → docker-compose.yml translator.
 *
 * Minimal implementation for testing catalog apps. Not a production orchestrator.
 * Generates a compose file that can spin up an app with its backing services.
 */

import { stringify } from "yaml";
import {
  resolveExpression,
  isExpression,
  deriveAppUrlProperties,
  type ResolverContext,
} from "../../../sdk/src/resolver.ts";
import type {
  NormalizedLaunch,
  NormalizedRequirement,
  NormalizedEnvVar,
  NormalizedHealth,
  Provides,
} from "../../../sdk/src/types.ts";

// --- Backing service definitions ---

interface BackingService {
  image: string;
  environment: Record<string, string>;
  /** Properties exposed to the app via set_env $ references */
  properties: Record<string, string>;
  healthcheck?: ComposeHealthcheck;
  /** Extra compose config (e.g. command for mongo replica set) */
  extra?: Record<string, unknown>;
}

interface ComposeHealthcheck {
  test: string[];
  interval: string;
  timeout: string;
  retries: number;
  start_period?: string;
}

const BACKING_SERVICES: Record<string, (name: string) => BackingService> = {
  postgres: (name) => ({
    image: "postgres:16-alpine",
    environment: {
      POSTGRES_USER: "launchfile",
      POSTGRES_PASSWORD: "launchfile",
      POSTGRES_DB: name,
    },
    properties: {
      host: `${name}-postgres`,
      port: "5432",
      user: "launchfile",
      password: "launchfile",
      name: name,
      url: `postgres://launchfile:launchfile@${name}-postgres:5432/${name}?sslmode=disable`,
    },
    healthcheck: {
      test: ["CMD-SHELL", `pg_isready -U launchfile -d ${name}`],
      interval: "5s",
      timeout: "5s",
      retries: 5,
    },
  }),

  mysql: (name) => ({
    image: "mysql:8",
    environment: {
      MYSQL_ROOT_PASSWORD: "launchfile",
      MYSQL_USER: "launchfile",
      MYSQL_PASSWORD: "launchfile",
      MYSQL_DATABASE: name,
    },
    properties: {
      host: `${name}-mysql`,
      port: "3306",
      user: "launchfile",
      password: "launchfile",
      name: name,
      url: `mysql://launchfile:launchfile@${name}-mysql:3306/${name}`,
    },
    healthcheck: {
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"],
      interval: "5s",
      timeout: "5s",
      retries: 5,
    },
  }),

  mariadb: (name) => ({
    image: "mariadb:11",
    environment: {
      MARIADB_ROOT_PASSWORD: "launchfile",
      MARIADB_USER: "launchfile",
      MARIADB_PASSWORD: "launchfile",
      MARIADB_DATABASE: name,
    },
    properties: {
      host: `${name}-mariadb`,
      port: "3306",
      user: "launchfile",
      password: "launchfile",
      name: name,
      url: `mysql://launchfile:launchfile@${name}-mariadb:3306/${name}`,
    },
    healthcheck: {
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"],
      interval: "5s",
      timeout: "5s",
      retries: 5,
    },
  }),

  redis: (name) => ({
    image: "redis:7-alpine",
    environment: {},
    properties: {
      host: `${name}-redis`,
      port: "6379",
      url: `redis://${name}-redis:6379`,
    },
    healthcheck: {
      test: ["CMD", "redis-cli", "ping"],
      interval: "5s",
      timeout: "5s",
      retries: 5,
    },
  }),

  mongodb: (name) => ({
    image: "mongo:7",
    environment: {
      MONGO_INITDB_ROOT_USERNAME: "launchfile",
      MONGO_INITDB_ROOT_PASSWORD: "launchfile",
    },
    properties: {
      host: `${name}-mongodb`,
      port: "27017",
      user: "launchfile",
      password: "launchfile",
      name: name,
      url: `mongodb://launchfile:launchfile@${name}-mongodb:27017/${name}?authSource=admin`,
    },
    healthcheck: {
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"],
      interval: "5s",
      timeout: "5s",
      retries: 5,
    },
  }),

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

  kafka: (name) => ({
    image: "redpandadata/redpanda:latest",
    environment: {},
    properties: {
      host: `${name}-kafka`,
      port: "9092",
      url: `${name}-kafka:9092`,
    },
    healthcheck: {
      test: ["CMD-SHELL", "rpk topic list > /dev/null 2>&1"],
      interval: "5s",
      timeout: "5s",
      retries: 10,
    },
    extra: {
      command: [
        "redpanda", "start",
        "--smp", "1",
        "--memory", "512M",
        "--reserve-memory", "0M",
        "--overprovisioned",
        "--kafka-addr", "PLAINTEXT://0.0.0.0:9092",
        "--advertise-kafka-addr", `PLAINTEXT://${name}-kafka:9092`,
      ],
    },
  }),
};

// --- Generator helpers ---

function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function generateUuid(): string {
  return crypto.randomUUID();
}

function generatePort(): string {
  // crypto, not Math.random: a secret may declare `generator: port`, so this
  // value can land in a secret/credential context (CodeQL js/insecure-randomness).
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(10000 + (buf[0]! % 55000));
}

// --- Main translator ---

export interface ComposeResult {
  yaml: string;
  /** Warnings about unsupported features */
  warnings: string[];
  /** All unique images referenced (for pull tracking) */
  images: string[];
}

export function launchToCompose(launch: NormalizedLaunch): ComposeResult {
  const warnings: string[] = [];
  const images: string[] = [];
  const services: Record<string, Record<string, unknown>> = {};
  const volumes: Record<string, Record<string, unknown>> = {};

  // Pre-generate app-wide secrets
  const secretValues: Record<string, string> = {};
  if (launch.secrets) {
    for (const [name, secret] of Object.entries(launch.secrets)) {
      if (secret.generator === "secret") secretValues[name] = generateSecret();
      else if (secret.generator === "uuid") secretValues[name] = generateUuid();
      else if (secret.generator === "port") secretValues[name] = generatePort();
    }
  }

  // App-wide resource properties for $<resource>.prop set_env resolution, shared
  // across components like the Docker provider's resourceMap (compose-generator).
  const resources: Record<string, Record<string, string>> = {};

  // App-wide component properties for $components.<name>.prop resolution, shared
  // across components like the Docker provider's componentMap. Populated as each
  // component is processed (below), so a later component can reference an earlier
  // one; an unregistered component resolves to "" (L-4), as on the provider.
  const components: Record<string, Record<string, string | number>> = {};

  for (const [componentName, component] of Object.entries(launch.components)) {
    const serviceName =
      componentName === "default" ? launch.name : `${launch.name}-${componentName}`;

    // Skip components that need build (no image)
    if (!component.image) {
      if (component.build) {
        warnings.push(`${componentName}: uses build — skipped (no image)`);
        continue;
      }
      warnings.push(`${componentName}: no image or build — skipped`);
      continue;
    }

    // Skip components with host requirements
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
      // Run as root in test harness to avoid volume ownership issues
      // (named/anonymous volumes mount as root, breaking non-root containers)
      user: "0:0",
    };

    // Ports — map to ephemeral host ports to avoid conflicts.
    // Loopback-bound exposed ports need a socat sidecar (added after main service)
    // that shares the network namespace. Port mappings for those go on the main
    // service since Docker disallows `ports` on `network_mode: service:*` containers.
    const directPorts = (component.provides ?? [])
      .filter((p) => p.exposed && !isLoopback(p.bind));
    const loopbackPorts = (component.provides ?? [])
      .filter((p) => p.exposed && isLoopback(p.bind));

    const allExposedPorts = [...directPorts, ...loopbackPorts];
    if (allExposedPorts.length > 0) {
      service.ports = allExposedPorts.map((p) => `0:${p.port}`);
    }

    // Register this component for $components.<name>.prop resolution, mirroring the
    // Docker provider (compose-generator.ts): the in-network address is the service
    // hostname on the component's first exposed port. We use the provider's
    // default-exposed semantics (`exposed !== false`) here — intentionally looser
    // than the host-port mapping above (explicit `exposed` only) — because the goal
    // is to predict what $components.* resolves to on a real provider, where any
    // component is reachable by service name on the ports it declares. url is always
    // http:// (the provider does the same); a component with no provides gets no
    // entry and $components.<name>.* degrades to "".
    const refPorts = (component.provides ?? []).filter((p) => p.exposed !== false);
    if (refPorts.length > 0) {
      const containerPort = refPorts[0]!.port;
      components[componentName] = {
        url: `http://${serviceName}:${containerPort}`,
        host: serviceName,
        port: containerPort,
      };
    }

    // Environment variables
    const env: Record<string, string> = {};

    // Provider-resolved storage paths (D-39). Like the Docker provider, this
    // harness bind-mounts each named volume at its declared path, so
    // $storage.<name>.path resolves to that in-container path.
    const storageCtx: Record<string, Record<string, string>> = {};
    if (component.storage) {
      for (const [volName, vol] of Object.entries(component.storage)) {
        storageCtx[volName] = { path: vol.path };
      }
    }

    // Best-effort $app.* context (D-33/D-35). The harness assigns ephemeral host
    // ports at generation time, so the real public URL/port aren't known here —
    // provide the host-shaped fields a localhost deploy would expose; unknown
    // $app.* (e.g. the actual port) degrade to "" via the resolver, as on a real
    // provider. The component context (secrets, storage, app) is shared by both
    // `env:` defaults and `set_env`, exactly as the providers resolve them.
    const appCtx: Record<string, string | number> = {
      name: launch.name,
      host: "localhost",
      url: "http://localhost",
      ...deriveAppUrlProperties("http://localhost"),
    };
    const baseCtx: ResolverContext = { secrets: secretValues, storage: storageCtx, app: appCtx, components };

    // Resolve env vars from the Launchfile
    if (component.env) {
      for (const [key, envVar] of Object.entries(component.env)) {
        const value = resolveEnvVar(envVar, baseCtx, key);
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
          serviceName,
          req,
          services,
          volumes,
          images,
          warnings,
        );
        if (backingResult) {
          resources[req.name ?? req.type] = backingResult.properties;
          // Wire env vars from set_env via the SDK resolver — the same path the
          // providers use. The enclosing resource is the single-segment scope
          // ($url, $host); named resources, $secrets.*, $storage.*.path, and
          // $app.* all resolve too (previously a resource-props-only stub left
          // those unresolved, so set_env using $secrets/$storage/$app was wrong).
          if (req.set_env) {
            const scopedCtx: ResolverContext = {
              ...baseCtx,
              resource: backingResult.properties,
              resources,
            };
            for (const [envKey, expr] of Object.entries(req.set_env)) {
              env[envKey] = resolveExpression(expr, scopedCtx);
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

    // Command override
    if (component.commands?.start) {
      service.command = component.commands.start.command;
    }

    // Health check
    if (component.health) {
      service.healthcheck = translateHealth(component.health, component.provides);
    }

    // Storage volumes — use anonymous volumes to preserve image filesystem ownership
    // (named volumes mount as root, which breaks non-root containers)
    if (component.storage) {
      const svcVolumes: string[] = [];
      for (const [, vol] of Object.entries(component.storage)) {
        svcVolumes.push(vol.path);
      }
      if (svcVolumes.length > 0) {
        service.volumes = svcVolumes;
      }
    }

    // Restart policy
    if (component.restart) {
      service.restart = component.restart;
    }

    services[serviceName] = service;

    // Socat sidecar for loopback-bound exposed ports.
    // Docker port forwarding can't reach ::1 or 127.0.0.1 inside the container,
    // so we add a forwarder sharing the network namespace that listens on 0.0.0.0
    // and proxies to the app's loopback address. The main service owns the port
    // mapping (Docker disallows `ports` on `network_mode: service:*` containers).
    for (const p of loopbackPorts) {
      const proxyName = `${serviceName}-proxy-${p.port}`;
      const target = p.bind === "::1" ? `TCP6:[::1]:${p.port}` : `TCP:127.0.0.1:${p.port}`;
      services[proxyName] = {
        image: "alpine/socat:latest",
        network_mode: `service:${serviceName}`,
        depends_on: {
          [serviceName]: { condition: component.health ? "service_healthy" : "service_started" },
        },
        command: `TCP-LISTEN:${p.port},fork,bind=0.0.0.0,reuseaddr ${target}`,
        restart: "on-failure",
      };
      images.push("alpine/socat:latest");
    }
  }

  const compose: Record<string, unknown> = { services };
  if (Object.keys(volumes).length > 0) {
    compose.volumes = volumes;
  }

  return {
    yaml: stringify(compose, { lineWidth: 120 }),
    warnings,
    images: [...new Set(images)],
  };
}

// --- Helpers ---

function resolveEnvVar(
  envVar: NormalizedEnvVar,
  ctx: ResolverContext,
  key?: string,
): string | undefined {
  // Generator takes precedence
  if (envVar.generator) {
    if (envVar.generator === "secret") return generateSecret();
    if (envVar.generator === "uuid") return generateUuid();
    if (envVar.generator === "port") return generatePort();
  }

  if (envVar.default !== undefined) {
    const val = String(envVar.default);
    // Resolve expressions ($secrets.*, $storage.*.path, $app.*, etc.) via the SDK
    // resolver — the same resolver the providers use, so the harness matches.
    if (isExpression(val)) {
      return resolveExpression(val, ctx);
    }
    return val;
  }

  // For required vars without defaults, provide smart placeholders
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
  _parentService: string,
  req: NormalizedRequirement,
  services: Record<string, Record<string, unknown>>,
  volumes: Record<string, Record<string, unknown>>,
  images: string[],
  warnings: string[],
): { serviceName: string; properties: Record<string, string> } | null {
  const type = req.type;
  const factory = BACKING_SERVICES[type];

  if (!factory) {
    warnings.push(`Unknown backing service type: ${type} — skipped`);
    return null;
  }

  const serviceName = `${appName}-${type}`;

  // Don't add duplicate services (multiple components might require the same type)
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

    // Add a data volume for the backing service
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

function isLoopback(bind: string | undefined): boolean {
  return bind === "::1" || bind === "127.0.0.1";
}

function translateHealth(
  health: NormalizedHealth,
  provides?: Provides[],
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

  // HTTP path-based health check — respect provides.bind for localhost-only apps
  const first = provides?.[0];
  const port = first?.port ?? 80;
  const host = first?.bind === "::1" ? "[::1]" : "localhost";
  const path = health.path ?? "/";

  return {
    test: ["CMD-SHELL", `wget -qO /dev/null http://${host}:${port}${path} || curl -sf http://${host}:${port}${path} > /dev/null || exit 1`],
    interval: health.interval ?? "10s",
    timeout: health.timeout ?? "5s",
    retries: health.retries ?? 5,
    start_period: health.start_period ?? "60s",
  };
}
