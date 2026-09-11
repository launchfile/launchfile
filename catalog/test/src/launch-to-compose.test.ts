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
 * $components.* context follow-up. The "Catalog" CI job runs this suite on
 * every PR (`.github/workflows/ci.yml`).
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { readLaunch } from "../../../sdk/src/reader.ts";
import { resourcePropertyKeys } from "../../../providers/docker/src/compose-generator.ts";
import { harnessBackingServiceTypes, launchToCompose } from "./launch-to-compose.ts";

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

  it("resolves $app.* via the docker provider's derivation (D-33/D-35, P-9)", () => {
    const env = envOf(
      `version: launch/v1
name: app3
image: nginx:alpine
provides:
  - protocol: http
    port: 8080
    exposed: true
env:
  PUBLIC_URL:
    default: "$app.url"
  AUTH:
    default: "$app.authority"
  SCHEME:
    default: "$app.scheme"
  PORT:
    default: "$app.port"
`,
      "app3",
    );
    // The harness passes no host ports (they are runtime-ephemeral), so the
    // provider's documented fallback answers: the declared container port of
    // the first `exposed: true` component.
    expect(env.PUBLIC_URL).toBe("http://localhost:8080");
    expect(env.AUTH).toBe("localhost:8080");
    expect(env.SCHEME).toBe("http");
    expect(env.PORT).toBe("8080");
  });

  it("degrades every $app.* to '' when nothing is exposed — the provider's rule (L-4)", () => {
    const env = envOf(
      `version: launch/v1
name: app4
image: nginx:alpine
env:
  PUBLIC_URL:
    default: "$app.url"
  AUTH:
    default: "$app.authority"
  PORT:
    default: "$app.port"
`,
      "app4",
    );
    // No exposed endpoint means the provider has no public address to assert —
    // url/authority resolve to "" and port to 0, never a guessed localhost.
    expect(env.PUBLIC_URL).toBe("");
    expect(env.AUTH).toBe("");
    expect(env.PORT).toBe("0");
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
    // mixapp exposes nothing, so the provider's $app.url is "" — the harness
    // shares the provider's derivation and must not invent a localhost origin.
    expect(env.ORIGIN).toBe("");
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
  it("does NOT treat a binding on an unprovisionable resource as supplying the value", () => {
    // `sqlite` has no factory here, so the binding can never inject. The
    // component is refused before its environment is resolved (D-64):
    // the key is absent, and a component that is not launching reports no
    // unsupplied variable — the runner fails on the refusal instead.
    const { yaml, unsuppliedRequired, resourceRefusals } = compose(`
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
    expect(yaml).not.toContain("acme/app:1");
    expect(resourceRefusals.map((r) => r.entry)).toEqual(["sqlite"]);
    expect(unsuppliedRequired).toEqual([]);
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

  it("every shipped catalog app's `content: operator` volumes are covered by its declared test_storage fixtures (D-50 adoption)", () => {
    // Each app supplies its own storagePaths via metadata.yaml's `test_storage:`
    // block (the same channel test-app.ts uses), so a marked volume with no
    // fixture — or a fixture path that doesn't exist on disk — still fails
    // here, the way it would fail `bun run src/test-app.ts <app>`.
    const appsDir = fileURLToPath(new URL("../../apps", import.meta.url));
    const refused: string[] = [];
    for (const app of readdirSync(appsDir)) {
      const file = resolve(appsDir, app, "Launchfile");
      if (!existsSync(file)) continue;
      const metadataPath = resolve(appsDir, app, "metadata.yaml");
      const metadata: Record<string, unknown> = existsSync(metadataPath)
        ? (parse(readFileSync(metadataPath, "utf-8")) ?? {})
        : {};
      const storagePaths = Object.fromEntries(
        Object.entries((metadata.test_storage as Record<string, unknown>) ?? {}).map(
          ([key, relPath]) => [key, resolve(appsDir, app, String(relPath))],
        ),
      );
      const { storageRefusals } = launchToCompose(readLaunch(readFileSync(file, "utf-8")), {
        storagePaths,
      });
      for (const r of storageRefusals) refused.push(`${app} [${r.component}]: ${r.volume}`);
    }
    expect(refused).toEqual([]);
  });
});

/**
 * `https-origin` (D-60): the harness's publication-context channel, and the
 * refusal that keeps it from certifying an app it could not honestly deploy.
 *
 * The harness runs no edge, so the only satisfaction it can offer is an
 * `https://` URL the caller supplied with `--url`. Anything else refuses a
 * `requires:` entry and leaves a `supports:` one unfulfilled — matching
 * `@launchfile/docker`, which is the point of the harness existing.
 */
describe("https-origin (D-60)", () => {
  const REQUIRES = `
name: vaultwarden
image: vaultwarden/server:latest
provides:
  - name: web
    protocol: http
    port: 80
    exposed: true
requires:
  - type: https-origin
    endpoint: web
    set_env:
      DOMAIN: $url
`;

  const SUPPORTS = `
name: grocy
image: linuxserver/grocy:latest
provides:
  - name: web
    protocol: http
    port: 80
    exposed: true
supports:
  - type: https-origin
    endpoint: web
    set_env:
      GROCY_URL: $url
`;

  it("wires set_env from an https:// appUrl", () => {
    const result = launchToCompose(readLaunch(REQUIRES), {
      appUrl: "https://vault.example.test",
    });
    expect(result.originRefusals).toEqual([]);
    const compose = parse(result.yaml) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    expect(compose.services.vaultwarden!.environment).toMatchObject({
      DOMAIN: "https://vault.example.test",
    });
  });

  it("refuses a requires entry with no appUrl, and omits the component", () => {
    const result = launchToCompose(readLaunch(REQUIRES));
    expect(result.originRefusals).toHaveLength(1);
    expect(result.originRefusals[0]!.entry).toBe('https-origin (endpoint "web")');
    const compose = parse(result.yaml) as { services: Record<string, unknown> };
    expect(compose.services.vaultwarden).toBeUndefined();
  });

  it("refuses a requires entry when the supplied appUrl is http://", () => {
    const result = launchToCompose(readLaunch(REQUIRES), {
      appUrl: "http://vault.example.test",
    });
    expect(result.originRefusals[0]!.message).toContain('scheme is "http"');
  });

  it("leaves a supports entry unfulfilled without refusing the component", () => {
    const result = launchToCompose(readLaunch(SUPPORTS));
    expect(result.originRefusals).toEqual([]);
    const compose = parse(result.yaml) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    expect(compose.services.grocy).toBeDefined();
    expect(compose.services.grocy!.environment?.GROCY_URL).toBeUndefined();
    expect(result.warnings.join("\n")).toContain("optional public HTTPS origin");
  });

  it("wires a supports entry when the origin is supplied", () => {
    const result = launchToCompose(readLaunch(SUPPORTS), {
      appUrl: "https://grocy.example.test",
    });
    const compose = parse(result.yaml) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    expect(compose.services.grocy!.environment).toMatchObject({
      GROCY_URL: "https://grocy.example.test",
    });
  });

  it("answers $app.* from the supplied URL for apps that declare no entry", () => {
    const plain = `
name: plain
image: app:1
provides:
  - protocol: http
    port: 8080
    exposed: true
env:
  PUBLIC_URL: $app.url
`;
    const result = launchToCompose(readLaunch(plain), {
      appUrl: "https://plain.example.test",
    });
    const compose = parse(result.yaml) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    expect(compose.services.plain!.environment).toMatchObject({
      PUBLIC_URL: "https://plain.example.test",
    });
  });
});

/**
 * A required backing-service type with no factory is refused, never warned
 * about and skipped (D-64, PROVIDERS.md §10 item 5). The harness gates
 * catalog PRs: a warn-and-skip here let `posthog` record
 * `health_check_passed: true` on a `kafka` the shipped provider did not stand
 * up. The provider's factory set is the authority on what may be certified.
 */
describe("unprovisionable requires — refused, not silently deployed (D-64)", () => {
  const compose = (yaml: string) => {
    const result = launchToCompose(readLaunch(yaml));
    const doc = parse(result.yaml) as { services?: Record<string, unknown> };
    return { ...result, services: Object.keys(doc.services ?? {}) };
  };

  it("refuses a component requiring a type with no factory, and omits it", () => {
    const { services, resourceRefusals, warnings } = compose(`
version: launch/v1
name: app
image: acme/app:1
requires:
  - type: snowflake
`);
    expect(services).toEqual([]);
    expect(resourceRefusals).toEqual([
      {
        component: "default",
        entry: "snowflake",
        message: 'this harness has no factory for type "snowflake"',
      },
    ]);
    expect(warnings.join(" ")).not.toContain("Unknown backing service type");
  });

  it("names a named entry as name plus type", () => {
    const { resourceRefusals } = compose(`
version: launch/v1
name: app
image: acme/app:1
requires:
  - type: snowflake
    name: warehouse
`);
    expect(resourceRefusals[0]!.entry).toBe('warehouse (type "snowflake")');
  });

  it("still deploys siblings that require only what it stands up", () => {
    const { services, resourceRefusals } = compose(`
version: launch/v1
name: app
components:
  web:
    image: acme/web:1
    requires:
      - type: postgres
  worker:
    image: acme/worker:1
    requires:
      - type: snowflake
`);
    expect(services.sort()).toEqual(["app-postgres", "app-web"]);
    expect(resourceRefusals.map((r) => r.component)).toEqual(["worker"]);
  });

  it("does not refuse a `supports:` entry — optional resources are not preconditions", () => {
    const { services, resourceRefusals } = compose(`
version: launch/v1
name: app
image: acme/app:1
supports:
  - type: snowflake
`);
    expect(services).toEqual(["app"]);
    expect(resourceRefusals).toEqual([]);
  });

  it("stands up no type the docker provider cannot — the provider is the authority", () => {
    const provider = new Set(Object.keys(resourcePropertyKeys()));
    const beyondProvider = harnessBackingServiceTypes().filter((t) => !provider.has(t));
    expect(beyondProvider).toEqual([]);
  });

  it("runs every catalog app under apps/ with no resource refusal", () => {
    const appsDir = fileURLToPath(new URL("../../apps", import.meta.url));
    const refused: string[] = [];
    for (const app of readdirSync(appsDir)) {
      const path = resolve(appsDir, app, "Launchfile");
      if (!existsSync(path)) continue;
      const { resourceRefusals } = launchToCompose(readLaunch(readFileSync(path, "utf8")));
      for (const r of resourceRefusals) refused.push(`${app} [${r.component}]: ${r.entry}`);
    }
    expect(refused).toEqual([]);
  });
});

describe("service.ports — protocol suffix (matches providers/docker/src/compose-generator.ts)", () => {
  it("suffixes a udp exposed port with /udp and leaves the http port bare", () => {
    const yaml = `
name: wg-easy
image: ghcr.io/wg-easy/wg-easy:15
provides:
  - name: web
    protocol: http
    port: 51821
    exposed: true
  - name: wg
    protocol: udp
    port: 51820
    exposed: true
`;
    const result = launchToCompose(readLaunch(yaml));
    const compose = parse(result.yaml) as {
      services: Record<string, { ports?: string[] }>;
    };
    expect(compose.services["wg-easy"]!.ports).toEqual(
      expect.arrayContaining(["0:51820/udp", "0:51821"]),
    );
    expect(compose.services["wg-easy"]!.ports).not.toContain("0:51820");
  });
});
