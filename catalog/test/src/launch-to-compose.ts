/**
 * Launchfile → docker-compose.yml translator.
 *
 * Minimal implementation for testing catalog apps. Not a production orchestrator.
 * Generates a compose file that can spin up an app with its backing services.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import { stringify } from "yaml";
import {
  resolveExpression,
  isExpression,
  type ResolverContext,
} from "../../../sdk/src/resolver.ts";
import { indexOperatorStoragePaths } from "../../../sdk/src/operator-storage.ts";
import { computeAppProperties } from "../../../providers/docker/src/app-url.ts";
import { unsuppliedRequiredEnv } from "../../../sdk/src/env.ts";
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

  // The same image, command and readiness gate as `@launchfile/docker`'s
  // factory, so a metadata.yaml regenerated from this harness lists the image
  // the shipped provider runs.
  kafka: (name) => ({
    image: "redpandadata/redpanda:v25.1.12",
    environment: {},
    properties: {
      host: `${name}-kafka`,
      port: "9092",
      url: `${name}-kafka:9092`,
    },
    healthcheck: {
      test: ["CMD-SHELL", "curl -sf http://localhost:9644/v1/status/ready || exit 1"],
      interval: "5s",
      timeout: "5s",
      retries: 10,
      start_period: "20s",
    },
    extra: {
      command: [
        "redpanda", "start",
        "--mode", "dev-container",
        "--smp", "1",
        "--memory", "1G",
        "--kafka-addr", "PLAINTEXT://0.0.0.0:9092",
        "--advertise-kafka-addr", `PLAINTEXT://${name}-kafka:9092`,
        "--set", "redpanda.auto_create_topics_enabled=true",
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
  /**
   * `required:` variables neither the Launchfile nor the declared test fixture
   * supplied (D-52, PROVIDERS.md §10 rule 8). Their keys are ABSENT from the
   * emitted compose. The runner turns a non-empty list into a hard failure
   * naming the app and the variable — a silent pass here is what let
   * `health_check_passed: true` certify apps the shipped provider refuses.
   */
  unsuppliedRequired: { component: string; key: string; sensitive: boolean }[];
  /**
   * `content: operator` volumes this compose cannot honestly satisfy (D-50):
   * no host path supplied, or the supplied path is absent/unreadable — the
   * directory is never created. Their mounts are ABSENT from the emitted
   * compose, never an empty volume. The runner turns a non-empty list into a
   * hard failure naming the app and the volume, exactly as it does for
   * `unsuppliedRequired` — a silent pass here would let catalog adoption of
   * the marker flip `health_check_passed` without anyone deciding it.
   */
  storageRefusals: { component: string; volume: string; message: string }[];
  /**
   * `https-origin` entries in `requires:` that this run cannot satisfy
   * (D-60 rule 5): no `appUrl` was supplied, or the supplied one is not
   * `https://`. The component is ABSENT from the emitted compose — the same
   * refusal `@launchfile/docker` performs. The runner turns a non-empty list
   * into a hard failure naming the app and the entry, exactly as it does for
   * `unsuppliedRequired`: starting the app anyway would record
   * `health_check_passed: true` for a deployment whose own web client cannot
   * be used, which is the failure the declaration exists to surface.
   */
  originRefusals: { component: string; entry: string; message: string }[];
  /**
   * `requires:` entries naming a backing-service type this harness has no
   * factory for (PROVIDERS.md §10 item 5, D-next). The component is ABSENT
   * from the emitted compose — the same refusal `@launchfile/docker`
   * performs for a type it cannot provision. The runner turns a non-empty
   * list into a hard failure naming the app and the entry, exactly as it
   * does for `originRefusals`: starting the app without the resource and
   * recording `health_check_passed: true` would certify an app the shipped
   * provider refuses to run.
   */
  resourceRefusals: { component: string; entry: string; message: string }[];
}

/**
 * The backing-service types this harness stands up. The provider is the
 * authority: `launch-to-compose.test.ts` fails when this set is not a subset
 * of `@launchfile/docker`'s, so the harness can never certify an app on a
 * type the shipped provider cannot provision.
 */
export function harnessBackingServiceTypes(): string[] {
  return Object.keys(BACKING_SERVICES);
}

export interface ComposeOpts {
  /**
   * The harness's declared operator channel: per-app values for `required:`
   * variables the Launchfile itself does not supply, from the app's
   * `metadata.yaml` `test_env:` block. Consulted ONLY for an otherwise
   * unsupplied required key. Rule 8 lets an operator supply a value; it forbids
   * the resolver inventing one, and a fixture is a reviewable test input rather
   * than a guess.
   */
  testEnv?: Record<string, string>;
  /**
   * Host paths for `content: operator` volumes (D-50), keyed by volume name
   * or `component.volume` — the same map the Docker provider's
   * `ComposeOpts.storagePaths` takes, with the same first-dot key rule: a
   * left half naming a component qualifies the key to that component;
   * anything else is a bare volume name, dots included. Values must be
   * absolute host paths that exist and are readable — an absent path is
   * refused, never created.
   */
  storagePaths?: Record<string, string>;
  /**
   * The public URL an owning orchestrator publishes this app at (D-58), the
   * same input as the Docker provider's `ComposeOpts.appUrl`. It answers
   * `$app.*` in place of the harness's `http://localhost:<port>` default, and
   * — when its scheme is `https` — it is what satisfies an `https-origin`
   * entry (D-60 rule 5: one channel, not two).
   */
  appUrl?: string;
}

/** The backing-service type that declares the app's public HTTPS origin (D-60). */
const HTTPS_ORIGIN = "https-origin";

/**
 * Wire one satisfied `https-origin` entry: register its single property and
 * resolve its `set_env` against it, exactly as the Docker provider does for a
 * supplied resource. `url` IS `$app.url` — one derivation, one value.
 */
function applyHttpsOrigin(
  entry: NormalizedRequirement,
  env: Record<string, string>,
  baseCtx: ResolverContext,
  resources: Record<string, Record<string, string>>,
  appCtx: Record<string, string | number>,
): void {
  const properties = { url: String(appCtx.url) };
  resources[entry.name ?? entry.type] = properties;
  if (!entry.set_env) return;
  const scopedCtx: ResolverContext = { ...baseCtx, resource: properties, resources };
  for (const [envKey, expr] of Object.entries(entry.set_env)) {
    env[envKey] = resolveExpression(expr, scopedCtx);
  }
}

export function launchToCompose(launch: NormalizedLaunch, opts: ComposeOpts = {}): ComposeResult {
  const warnings: string[] = [];
  const images: string[] = [];
  const unsuppliedRequired: ComposeResult["unsuppliedRequired"] = [];
  const storageRefusals: ComposeResult["storageRefusals"] = [];
  const originRefusals: ComposeResult["originRefusals"] = [];
  const resourceRefusals: ComposeResult["resourceRefusals"] = [];
  const services: Record<string, Record<string, unknown>> = {};
  const volumes: Record<string, Record<string, unknown>> = {};

  // D-50 storage-path keys, indexed by the SDK so this harness applies the
  // same key rule the providers do — a harness that matched keys its own way
  // could certify a compose file no provider would produce.
  const storageIndex = indexOperatorStoragePaths(launch, opts.storagePaths);
  const usedStorageKeys = new Set<string>();

  // Pre-generate app-wide secrets
  const secretValues: Record<string, string> = {};
  if (launch.secrets) {
    for (const [name, secret] of Object.entries(launch.secrets)) {
      if (secret.generator === "secret") secretValues[name] = generateSecret();
      else if (secret.generator === "uuid") secretValues[name] = generateUuid();
      else if (secret.generator === "port") secretValues[name] = generatePort();
    }
  }

  // Whether an `https-origin` entry can be satisfied at all on this run
  // (D-60 rule 5). The harness runs no edge, so the only satisfaction is an
  // `https://` URL the caller supplied; the probe is computed once, from the
  // same derivation every component's $app.* uses.
  const appPropertiesProbe = computeAppProperties(launch, undefined, opts.appUrl);
  const httpsOriginSatisfied =
    opts.appUrl !== undefined && appPropertiesProbe.scheme === "https";

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

    // Refuse components whose host capabilities this harness cannot grant.
    // Both spellings are checked: the D-44 `host:` entry form and the legacy
    // block. Checking only the block would deploy a component whose required
    // capability was never granted, and then stamp it healthy.
    const refusedCapabilities = (component.requires ?? [])
      .filter((r) => r.host)
      .flatMap((r) =>
        Object.entries(r.host ?? {}).map(([cap, val]) => `${cap}=${String(val)}`),
      );
    if (refusedCapabilities.length > 0) {
      warnings.push(
        `${componentName}: requires host capabilities this harness cannot grant ` +
          `(${refusedCapabilities.join("; ")}) — skipped`,
      );
      continue;
    }

    // A required `https-origin` (D-60) this run cannot satisfy REFUSES the
    // component, as the shipped Docker provider does. The harness has no edge
    // of its own; the only satisfaction it can offer is an `https://` appUrl
    // the caller supplied. No probe — the check is on the scheme alone.
    const originRefused = (component.requires ?? [])
      .filter((r) => r.type === HTTPS_ORIGIN)
      .filter(() => !httpsOriginSatisfied)
      .map((r) => ({
        component: componentName,
        entry: `${r.name ?? r.type} (endpoint "${r.endpoint ?? "?"}")`,
        message:
          opts.appUrl === undefined
            ? "no publication URL supplied — pass --url https://<host>"
            : `the supplied publication URL's scheme is "${String(appPropertiesProbe.scheme)}", not https`,
      }));
    if (originRefused.length > 0) {
      originRefusals.push(...originRefused);
      continue;
    }

    // A required backing-service type this harness has no factory for
    // REFUSES the component (D-next), as the shipped Docker provider does.
    // The harness has no supplied-resource channel, so nothing can satisfy
    // the entry from outside; warning and starting the app without the
    // resource is exactly what let `health_check_passed: true` certify an
    // app the provider could not run.
    const resourceRefused = (component.requires ?? [])
      .filter((r) => !r.host && r.type !== HTTPS_ORIGIN && !BACKING_SERVICES[r.type])
      .map((r) => ({
        component: componentName,
        entry: r.name === undefined ? r.type : `${r.name} (type "${r.type}")`,
        message: `this harness has no factory for type "${r.type}"`,
      }));
    if (resourceRefused.length > 0) {
      resourceRefusals.push(...resourceRefused);
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

    // $app.* context (D-33/D-35) — the docker provider's own derivation,
    // imported so this harness cannot drift from the rule it exercises (P-9).
    // Host ports here are runtime-ephemeral ("0:<port>" mappings), so none are
    // passed: the provider's documented fallback answers — the declared
    // container port of the first `exposed: true` component,
    // http://localhost:<port>. The component context (secrets, storage, app)
    // is shared by both `env:` defaults and `set_env`, exactly as the
    // providers resolve them.
    const appCtx: Record<string, string | number> = computeAppProperties(
      launch,
      undefined,
      opts.appUrl,
    );
    const baseCtx: ResolverContext = { secrets: secretValues, storage: storageCtx, app: appCtx, components };

    // Resolve env vars from the Launchfile
    if (component.env) {
      for (const [key, envVar] of Object.entries(component.env)) {
        const value = resolveEnvVar(envVar, baseCtx);
        if (value !== undefined) {
          env[key] = value;
        }
      }
    }

    // Backing services from requires
    const dependsOn: Record<string, { condition: string }> = {};

    if (component.requires?.length) {
      for (const req of component.requires) {
        if (req.host) continue; // capability, not a backing service (D-44)
        if (req.type === HTTPS_ORIGIN) {
          // Reached only when satisfied — the refusal above skipped the
          // component otherwise. One registered property, `url` (D-60 rule
          // 4), holding the same string as `$app.url`.
          applyHttpsOrigin(req, env, baseCtx, resources, appCtx);
          continue;
        }
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

    // `supports: https-origin` (D-60 rule 6) — the optional mood. Satisfied,
    // it wires like any other resource; unsatisfied, the component still runs
    // and its set_env bindings are simply absent.
    for (const sup of component.supports ?? []) {
      if (sup.type !== HTTPS_ORIGIN) continue;
      if (httpsOriginSatisfied) {
        applyHttpsOrigin(sup, env, baseCtx, resources, appCtx);
      } else {
        warnings.push(
          `${componentName}: optional public HTTPS origin ${sup.name ?? sup.type} ` +
            `(endpoint "${sup.endpoint ?? "?"}") not satisfied — running degraded`,
        );
      }
    }

    // Unsupplied `required:` variables (D-52, PROVIDERS.md §10 rule 8). Runs
    // AFTER the `set_env` injection above because the test is arrival, not
    // declaration: a `supports:` binding never injects here (this harness does
    // not provision optional resources) and a binding on an unknown backing
    // type does not either. The declared fixture gets one look; whatever it
    // does not cover is recorded for the runner to fail on by name.
    for (const { key, sensitive } of unsuppliedRequiredEnv(component, Object.keys(env))) {
      const supplied = opts.testEnv?.[key];
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
    // (named volumes mount as root, which breaks non-root containers). A
    // `content: operator` volume (D-50) is instead bound to the supplied host
    // path, mirroring the Docker provider's four states: path supplied →
    // bind; no path → refused; path absent/unreadable → refused, never
    // created; no marker → unchanged. A refused volume gets NO mount — an
    // empty volume standing in for the operator's content is exactly the
    // fabrication whose health pass this harness must not certify.
    if (component.storage) {
      const svcVolumes: string[] = [];
      for (const [volName, vol] of Object.entries(component.storage)) {
        if (vol.content === "operator") {
          const bound = storageIndex.lookup(componentName, volName);
          if (!bound) {
            storageRefusals.push({
              component: componentName,
              volume: volName,
              message: `no host path supplied for this \`content: operator\` volume — pass storagePaths ({ "${volName}": "<path>" })`,
            });
            continue;
          }
          usedStorageKeys.add(bound.key);
          let readable = false;
          try {
            accessSync(bound.path, fsConstants.R_OK);
            readable = true;
          } catch {
            // fall through to the refusal below
          }
          if (!readable) {
            storageRefusals.push({
              component: componentName,
              volume: volName,
              message: `supplied path "${bound.path}" does not exist or is not readable — refusing to create it (D-50)`,
            });
            continue;
          }
          svcVolumes.push(`${bound.path}:${vol.path}`);
          continue;
        }
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

  // A storage-path key that bound nothing surfaces as a warning — only
  // `content: operator` volumes are bindable, and a typo'd name should not
  // vanish silently (the unbound marked volume it left behind is refused
  // separately, so this alone never masks a refusal).
  for (const key of storageIndex.unusedKeys(usedStorageKeys)) {
    warnings.push(`storagePaths key "${key}" matches no \`content: operator\` volume — ignored`);
  }

  const compose: Record<string, unknown> = { services };
  if (Object.keys(volumes).length > 0) {
    compose.volumes = volumes;
  }

  return {
    yaml: stringify(compose, { lineWidth: 120 }),
    warnings,
    images: [...new Set(images)],
    unsuppliedRequired,
    storageRefusals,
    originRefusals,
    resourceRefusals,
  };
}

// --- Helpers ---

function resolveEnvVar(
  envVar: NormalizedEnvVar,
  ctx: ResolverContext,
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

  // A `required:` var the file supplies no value for gets nothing here (D-52,
  // PROVIDERS.md §10 rule 8). The harness is an OPERATOR, so it may still supply
  // one — but only from `opts.testEnv`, a declared fixture reviewable in the
  // catalog PR, never from a guess made inside this resolver.
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
    // The component loop refuses a component with such an entry before it
    // reaches here, so this is a bug in this file, not a translation outcome.
    throw new Error(
      `addBackingService: no factory for type "${type}" — the caller must refuse first`,
    );
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
