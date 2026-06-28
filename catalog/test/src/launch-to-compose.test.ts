/**
 * Characterization tests for the catalog compose-gen harness's expression
 * resolution. This harness predicts what a real provider (the Docker provider)
 * resolves `$`-expressions to, so these tests lock in that both `env:` defaults
 * and `requires[].set_env` route through the SDK resolver with the same context
 * the providers build — secrets, storage paths (D-39), `$app.*` (D-33/D-35),
 * cross-resource refs, and `$components.*`.
 *
 * Regression anchor for the PR #104 fix (set_env was using a resource-props-only
 * stub, so $secrets/$storage/$app silently resolved to the raw "$ref") and the
 * $components.* context follow-up. catalog/test is not in the CI build order, so
 * run this manually: `cd catalog/test && bun install && bun run test`.
 */

import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { readLaunch } from "../../../sdk/src/reader.ts";
import { launchToCompose } from "./launch-to-compose.ts";

/** Compose a Launchfile YAML and return the resolved `environment` for a service. */
function envOf(yaml: string, serviceName: string): Record<string, string> {
  const launch = readLaunch(yaml);
  const { yaml: composeYaml } = launchToCompose(launch);
  const compose = parse(composeYaml) as {
    services: Record<string, { environment?: Record<string, string> }>;
  };
  const service = compose.services[serviceName];
  if (!service) {
    throw new Error(
      `service "${serviceName}" not found; got: ${Object.keys(compose.services).join(", ")}`,
    );
  }
  return service.environment ?? {};
}

const HEX64 = /^[0-9a-f]{64}$/;

describe("env: defaults route through the SDK resolver", () => {
  it("resolves $storage.<name>.path to the declared volume path (D-39)", () => {
    const env = envOf(
      `version: launch/v1
name: storeapp
image: nginx:alpine
storage:
  data:
    path: /var/lib/storeapp/data
    persistent: true
env:
  DATA_DIR:
    default: "$storage.data.path"
`,
      "storeapp",
    );
    expect(env.DATA_DIR).toBe("/var/lib/storeapp/data");
  });

  it("resolves $secrets.* and keeps repeated references stable", () => {
    const env = envOf(
      `version: launch/v1
name: secretapp
image: nginx:alpine
secrets:
  app-key:
    generator: secret
env:
  PRIMARY:
    default: "\${secrets.app-key}"
  SECONDARY:
    default: "\${secrets.app-key}"
`,
      "secretapp",
    );
    expect(env.PRIMARY).toMatch(HEX64);
    // The same secret name resolves to the same generated value everywhere.
    expect(env.SECONDARY).toBe(env.PRIMARY);
  });

  it("resolves $app.* host-shaped properties (D-33/D-35) and degrades the unknown ones to ''", () => {
    const env = envOf(
      `version: launch/v1
name: app3
image: nginx:alpine
env:
  PUBLIC_URL:
    default: "$app.url"
  AUTH:
    default: "$app.authority"
  SCHEME:
    default: "$app.scheme"
  PORT_UNKNOWN:
    default: "$app.port"
`,
      "app3",
    );
    expect(env.PUBLIC_URL).toBe("http://localhost");
    expect(env.AUTH).toBe("localhost");
    expect(env.SCHEME).toBe("http");
    // The harness assigns ephemeral host ports, so the real app port is unknown
    // here — like a real provider, an unresolved $app.* degrades to "" (L-4).
    expect(env.PORT_UNKNOWN).toBe("");
  });
});

describe("requires[].set_env routes through the SDK resolver (PR #104 anchor)", () => {
  it("resolves enclosing-resource ($host/$name) and cross-resource ($type.url) refs", () => {
    const env = envOf(
      `version: launch/v1
name: dbapp
image: nginx:alpine
requires:
  - type: postgres
    set_env:
      DB_HOST: "$host"
      DB_NAME: "$name"
      DB_URL: "$postgres.url"
`,
      "dbapp",
    );
    expect(env.DB_HOST).toBe("dbapp-postgres");
    expect(env.DB_NAME).toBe("dbapp");
    expect(env.DB_URL).toBe(
      "postgres://launchfile:launchfile@dbapp-postgres:5432/dbapp?sslmode=disable",
    );
  });

  it("resolves $storage.<name>.path, $secrets.*, and $app.* inside set_env (the bug #104 fixed)", () => {
    const env = envOf(
      `version: launch/v1
name: mixapp
image: nginx:alpine
secrets:
  tok:
    generator: secret
storage:
  vol:
    path: /data/mix
    persistent: true
requires:
  - type: redis
    set_env:
      CACHE_DIR: "$storage.vol.path"
      TOKEN: "\${secrets.tok}"
      ORIGIN: "$app.url"
      REDIS_URL: "$url"
`,
      "mixapp",
    );
    expect(env.CACHE_DIR).toBe("/data/mix");
    expect(env.TOKEN).toMatch(HEX64);
    expect(env.ORIGIN).toBe("http://localhost");
    expect(env.REDIS_URL).toBe("redis://mixapp-redis:6379");
  });
});

describe("$components.<name>.* context", () => {
  it("resolves a later component's reference to an earlier component's URL", () => {
    // web is declared before api, so by the time api's env resolves the
    // component map already holds web — mirroring the Docker provider, whose
    // componentMap is populated in declaration order.
    const env = envOf(
      `version: launch/v1
name: stack
components:
  web:
    image: nginx:alpine
    provides:
      - protocol: http
        port: 8080
        exposed: true
  api:
    image: node:alpine
    env:
      BACKEND_URL:
        default: "$components.web.url"
      BACKEND_HOST:
        default: "$components.web.host"
      MISSING:
        default: "$components.ghost.url"
`,
      "stack-api",
    );
    expect(env.BACKEND_URL).toBe("http://stack-web:8080");
    expect(env.BACKEND_HOST).toBe("stack-web");
    // An unknown component degrades to "" (L-4), like any unresolved reference.
    expect(env.MISSING).toBe("");
  });
});
