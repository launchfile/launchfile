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

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("host capabilities — refused, not silently deployed (D-44)", () => {
  const mk = (extra: string) =>
    readLaunch(
      `version: launch/v1\nname: dockge\nimage: louislam/dockge:1\n${extra}`,
    );
  const run = (extra: string) => {
    const { yaml: composeYaml, warnings } = launchToCompose(mk(extra));
    const compose = parse(composeYaml) as { services?: Record<string, unknown> };
    return { deployed: Object.keys(compose.services ?? {}).length > 0, warnings };
  };

  it("refuses a component whose required capability cannot be granted", () => {
    const { deployed, warnings } = run(
      "requires:\n  - host: { container_runtime: docker }\n",
    );
    expect(deployed).toBe(false);
    expect(warnings.join(" ")).toContain("container_runtime=docker");
  });

  it("treats the entry form and the legacy block identically", () => {
    // The harness gates catalog PRs. Knowing only the legacy block would deploy
    // an app whose required socket was never granted, then stamp it healthy.
    expect(run("requires:\n  - host: { container_runtime: docker }\n").deployed).toBe(
      run("host:\n  docker: required\n").deployed,
    );
  });

  it("does not provision a capability entry as a backing service", () => {
    const { warnings } = run("requires:\n  - host: { container_runtime: docker }\n");
    expect(warnings.join(" ")).not.toContain("Unknown backing service type");
  });

  it("still deploys a component with no host capabilities", () => {
    expect(run("requires:\n  - postgres\n").deployed).toBe(true);
  });
});

/**
 * The `required:` arrival table for the harness (D-52, PROVIDERS.md §10 rule 8),
 * ported from `providers/aws/src/__tests__/translate.test.ts` and verb-adjusted.
 *
 * The harness is an OPERATOR, not a provider: rule 8 lets it supply a value from
 * a declared channel (`test_env:` in the app's metadata.yaml) and forbids it
 * inventing one inside the resolver. Before this change it did the second, with
 * the same name-derived guesses as the docker provider — which is what let
 * `health_check_passed: true` certify apps the shipped provider refuses.
 */
describe("unsupplied required env (rule 8, D-52)", () => {
  const compose = (yaml: string, testEnv?: Record<string, string>) => {
    const result = launchToCompose(readLaunch(yaml), testEnv ? { testEnv } : {});
    const doc = parse(result.yaml) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    return { ...result, doc };
  };

  const REQUIRED = `
name: app
image: acme/app:1
provides:
  - { protocol: http, port: 3000, exposed: true }
env:
  API_KEY:
    required: true
    sensitive: true
  SITE_URL:
    required: true
  HAS_DEFAULT:
    required: true
    default: fine
  GENERATED:
    required: true
    generator: secret
`;

  // 1
  it("leaves the key absent from the emitted compose — absent, not empty", () => {
    const { doc } = compose(REQUIRED);
    const env = doc.services.app!.environment!;
    expect("API_KEY" in env).toBe(false);
    expect("SITE_URL" in env).toBe(false);
  });

  // 2
  it("never invents a value for it", () => {
    const { yaml } = compose(`
name: app
image: acme/app:1
env:
  PGRST_DB_URI: { required: true }
  EMAIL_SMTP_HOST: { required: true }
  ADMIN_TOKEN: { required: true, sensitive: true }
`);
    expect(yaml).not.toContain("PLACEHOLDER");
    expect(yaml).not.toContain("http://localhost");
    expect(yaml).not.toContain("test@localhost");
  });

  // 3
  it("still emits vars the file supplies via default or generator", () => {
    const { doc, unsuppliedRequired } = compose(REQUIRED);
    const env = doc.services.app!.environment!;
    expect(env.HAS_DEFAULT).toBe("fine");
    expect(env.GENERATED).toMatch(HEX64);
    expect(unsuppliedRequired.map((v) => v.key).sort()).toEqual(["API_KEY", "SITE_URL"]);
  });

  // 4
  it("treats a set_env binding on a provisioned resource as supplying the value", () => {
    const { doc, unsuppliedRequired } = compose(`
name: app
image: acme/app:1
requires:
  - type: postgres
    set_env:
      DATABASE_URL: $url
env:
  DATABASE_URL:
    required: true
`);
    expect(doc.services.app!.environment!.DATABASE_URL).toContain("postgres");
    expect(unsuppliedRequired).toEqual([]);
  });

  // 5
  it("does NOT treat a binding on an unmappable resource as supplying the value", () => {
    const { yaml, unsuppliedRequired } = compose(`
name: app
image: acme/app:1
requires:
  - type: sqlite
    set_env:
      DB_URL: $url
env:
  DB_URL:
    required: true
    sensitive: true
`);
    expect(yaml).not.toContain("DB_URL");
    expect(unsuppliedRequired).toEqual([
      { component: "default", key: "DB_URL", sensitive: true },
    ]);
  });

  // 6
  it("does NOT treat a supports-only binding as supplying the value", () => {
    const { yaml, unsuppliedRequired } = compose(`
name: app
image: acme/app:1
supports:
  - type: redis
    set_env:
      CACHE_URL: $url
env:
  CACHE_URL:
    required: true
`);
    expect(yaml).not.toContain("CACHE_URL");
    expect(unsuppliedRequired.map((v) => v.key)).toEqual(["CACHE_URL"]);
  });

  it("names the component and marks sensitive vars, so the runner can fail by name", () => {
    // What test-app.ts turns into a hard failure: without this the app's run
    // passes silently and metadata.yaml records health_check_passed: true.
    const { unsuppliedRequired } = compose(`
name: app
components:
  web:
    image: acme/web:1
    env:
      SITE_URL: { required: true }
  admin:
    image: acme/admin:1
    env:
      ADMIN_TOKEN: { required: true, sensitive: true }
`);
    expect(unsuppliedRequired).toEqual([
      { component: "web", key: "SITE_URL", sensitive: false },
      { component: "admin", key: "ADMIN_TOKEN", sensitive: true },
    ]);
  });

  describe("test_env: the declared operator channel", () => {
    it("supplies the value and stops reporting the var", () => {
      const { doc, unsuppliedRequired } = compose(REQUIRED, {
        API_KEY: "fixture-key",
        SITE_URL: "http://app.test",
      });
      const env = doc.services.app!.environment!;
      expect(env.API_KEY).toBe("fixture-key");
      expect(env.SITE_URL).toBe("http://app.test");
      expect(unsuppliedRequired).toEqual([]);
    });

    it("never overrides a default or a set_env binding", () => {
      const { doc } = compose(
        `
name: app
image: acme/app:1
requires:
  - type: postgres
    set_env:
      DATABASE_URL: $url
env:
  HAS_DEFAULT:
    required: true
    default: fine
  DATABASE_URL:
    required: true
`,
        { HAS_DEFAULT: "hijacked", DATABASE_URL: "hijacked" },
      );
      const env = doc.services.app!.environment!;
      expect(env.HAS_DEFAULT).toBe("fine");
      expect(env.DATABASE_URL).toContain("postgres");
    });
  });

  it("every catalog app under apps/ launches with no unsupplied required var", () => {
    // D-52 Conformance at adoption: the catalog pass lands with the provider
    // change, so no shipped app regresses to undeployable.
    const appsDir = fileURLToPath(new URL("../../apps", import.meta.url));
    const failures: string[] = [];
    for (const app of readdirSync(appsDir)) {
      const file = resolve(appsDir, app, "Launchfile");
      if (!existsSync(file)) continue;
      const metaPath = resolve(appsDir, app, "metadata.yaml");
      const meta = existsSync(metaPath)
        ? ((parse(readFileSync(metaPath, "utf-8")) ?? {}) as Record<string, unknown>)
        : {};
      const testEnv = Object.fromEntries(
        Object.entries((meta.test_env as Record<string, unknown>) ?? {}).map(([k, v]) => [
          k,
          String(v),
        ]),
      );
      const { unsuppliedRequired } = launchToCompose(
        readLaunch(readFileSync(file, "utf-8")),
        { testEnv },
      );
      for (const v of unsuppliedRequired) failures.push(`${app} [${v.component}]: ${v.key}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("content: operator volumes (D-50)", () => {
  const MARKED = `
name: media
image: navidrome:latest
storage:
  music:
    path: /music
    content: operator
    persistent: true
  data:
    path: /data
`;

  it("binds a supplied, existing path instead of an anonymous volume (row 1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lf-harness-content-"));
    try {
      const result = launchToCompose(readLaunch(MARKED), { storagePaths: { music: dir } });
      expect(result.storageRefusals).toEqual([]);
      expect(result.yaml).toContain(`${dir}:/music`);
      // The unmarked volume keeps its anonymous-volume form.
      expect(result.yaml).toContain("- /data");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unbound marked volume — no mount, no empty volume (row 2)", () => {
    const result = launchToCompose(readLaunch(MARKED));
    expect(result.storageRefusals).toHaveLength(1);
    expect(result.storageRefusals[0]).toMatchObject({ component: "default", volume: "music" });
    expect(result.yaml).not.toContain("/music");
  });

  it("refuses a supplied path that does not exist — never creates it (row 3)", () => {
    const missing = join(tmpdir(), `lf-harness-missing-${Date.now()}`);
    const result = launchToCompose(readLaunch(MARKED), { storagePaths: { music: missing } });
    expect(result.storageRefusals).toHaveLength(1);
    expect(result.storageRefusals[0]!.message).toContain("does not exist or is not readable");
    expect(existsSync(missing)).toBe(false);
    expect(result.yaml).not.toContain(missing);
  });

  it("leaves an unmarked launch byte-identical whether or not storagePaths is passed (row 4)", () => {
    const yaml = `
name: plain
image: nginx
storage:
  data:
    path: /data
`;
    const without = launchToCompose(readLaunch(yaml));
    const withMap = launchToCompose(readLaunch(yaml), { storagePaths: { data: "/srv/data" } });
    expect(withMap.yaml).toBe(without.yaml);
    expect(withMap.warnings.join("\n")).toContain("matches no `content: operator` volume");
  });

  it("routes component.volume keys by the first dot; an unknown left half stays a volume name", () => {
    const dirA = mkdtempSync(join(tmpdir(), "lf-harness-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "lf-harness-b-"));
    try {
      const launch = readLaunch(`
name: shelf
components:
  web:
    image: shelf:latest
    storage:
      library:
        path: /library
        content: operator
  sync:
    image: syncer:latest
    storage:
      drop.box:
        path: /drop
        content: operator
`);
      const result = launchToCompose(launch, {
        storagePaths: { "web.library": dirA, "drop.box": dirB },
      });
      expect(result.storageRefusals).toEqual([]);
      expect(result.yaml).toContain(`${dirA}:/library`);
      expect(result.yaml).toContain(`${dirB}:/drop`);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("no shipped catalog app is refused: none carries the marker yet (adoption gate)", () => {
    // D-50 Conformance at adoption: the marker lands in the catalog only
    // after every surface (this harness included) implements the channel.
    const appsDir = fileURLToPath(new URL("../../apps", import.meta.url));
    const refused: string[] = [];
    for (const app of readdirSync(appsDir)) {
      const file = resolve(appsDir, app, "Launchfile");
      if (!existsSync(file)) continue;
      const { storageRefusals } = launchToCompose(readLaunch(readFileSync(file, "utf-8")));
      for (const r of storageRefusals) refused.push(`${app} [${r.component}]: ${r.volume}`);
    }
    expect(refused).toEqual([]);
  });
});
