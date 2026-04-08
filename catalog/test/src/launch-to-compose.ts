/**
 * Launchfile → docker-compose.yml translator.
 *
 * Minimal implementation for testing catalog apps. Not a production orchestrator.
 * Generates a compose file that can spin up an app with its backing services.
 */

import { stringify } from "yaml";
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
  return String(10000 + Math.floor(Math.random() * 55000));
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

    // Environment variables
    const env: Record<string, string> = {};

    // Resolve env vars from the Launchfile
    if (component.env) {
      for (const [key, envVar] of Object.entries(component.env)) {
        const value = resolveEnvVar(envVar, secretValues, key);
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
          // Wire env vars from set_env
          if (req.set_env) {
            for (const [envKey, propRef] of Object.entries(req.set_env)) {
              const resolved = resolvePropRef(propRef, backingResult.properties);
              env[envKey] = resolved;
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
  secrets: Record<string, string>,
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
    // Resolve $secrets.* references in defaults
    return val.replace(/\$secrets\.(\w+)/g, (_, name) => secrets[name] ?? "");
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

function resolvePropRef(ref: string, properties: Record<string, string>): string {
  // $url → properties.url, $host → properties.host, etc.
  if (ref.startsWith("$")) {
    const prop = ref.slice(1);
    return properties[prop] ?? ref;
  }
  return ref;
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
