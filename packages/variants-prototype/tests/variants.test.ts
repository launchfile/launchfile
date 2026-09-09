import { readFileSync } from "node:fs";
import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { expandVariants, readVariants, redactPreview } from "../src/variants.js";

const fixture = (relative: string) => readFileSync(new URL(`../examples/gitea/${relative}`, import.meta.url), "utf8");
const example = fixture("Launchfile");
const minimal = () => ({ name: "app", image: "example/app:1" });

describe("configuration selection", () => {
  it("matches a complete ordinary SQLite Launchfile without selection", () => {
    const preview = readVariants(example);
    expect(preview.launch).toEqual(readLaunch(fixture("sqlite/Launchfile")));
    expect(preview.selected).toBeNull();
    expect(preview.validated).toEqual(["baseline", "postgres"]);
  });

  it("matches a complete ordinary PostgreSQL Launchfile, with no SQLite settings", () => {
    const preview = readVariants(example, "postgres");
    expect(preview.launch).toEqual(readLaunch(fixture("postgres/Launchfile")));
    const component = preview.launch.components.default!;
    expect(component.env).not.toHaveProperty("GITEA__database__DB_TYPE");
    expect(component.env).not.toHaveProperty("GITEA__database__PATH");
    expect(component.requires![0]!.set_env!.GITEA__database__PASSWD).toBe("$password");
    expect(component.storage!.data!.persistent).toBe(true);
  });

  it("replaces nested maps and lists in full, while retaining absent fields", () => {
    const result = expandVariants({
      ...minimal(), env: { OLD: "old", KEEP: "old" }, requires: ["postgres", "redis"],
      storage: { old: { path: "/old", persistent: true } },
      variants: { small: { env: { KEEP: "new" }, requires: ["sqlite"], storage: { cache: { path: "/cache" } } } },
    }, "small").launch.components.default!;
    expect(result.env).toEqual({ KEEP: { default: "new" } });
    expect(result.requires).toEqual([{ type: "sqlite" }]);
    expect(result.storage).toEqual({ cache: { path: "/cache" } });
    expect(result.image).toBe("example/app:1");
  });

  it("permits explicit empty maps and lists when no references become invalid", () => {
    const result = expandVariants({
      ...minimal(), env: { A: "a" }, provides: [{ protocol: "http", port: 80 }],
      requires: ["postgres"], supports: ["redis"], storage: { data: { path: "/data" } }, health: "/health",
      variants: { empty: { env: {}, provides: [], requires: [], supports: [], storage: {}, health: {} } },
    }, "empty").launch.components.default!;
    expect(result.env).toEqual({}); expect(result.provides).toEqual([]);
    expect(result.requires).toEqual([]); expect(result.supports).toEqual([]);
    expect(result.storage).toEqual({}); expect(result.health).toEqual({});
  });

  it("validates a broken baseline even when the selected variant would repair it", () => {
    expect(() => expandVariants({ ...minimal(), provides: [{ protocol: "http", port: 0 }], variants: { fixed: { provides: [] } } }, "fixed")).toThrow("baseline");
  });

  it("validates an invalid nonselected variant before returning the baseline", () => {
    expect(() => expandVariants({ ...minimal(), variants: { broken: { provides: [{ protocol: "http", port: 70000 }] } } })).toThrow("variants.broken");
  });

  it("validates a nonselected variant's dependency references", () => {
    expect(() => expandVariants({ ...minimal(), variants: { broken: { env: { DB: "$missing.url" } }, okay: {} } }, "okay")).toThrow("variants.broken.env.DB");
  });

  it.each(["missing", "postgres,sqlite", "", "baseline"])("refuses unsupported selection %j", (selection) => {
    expect(() => readVariants(example, selection)).toThrow("unknown variant");
  });

  it("does not mutate input objects, YAML aliases, or later previews", () => {
    const shared = { A: { default: "original" } };
    const input = { ...minimal(), env: shared, variants: { other: { env: shared } } };
    const first = expandVariants(input, "other");
    first.launch.components.default!.env!.A!.default = "changed";
    expect(shared.A.default).toBe("original");
    expect(expandVariants(input).launch.components.default!.env!.A!.default).toBe("original");
    const yaml = "name: app\nimage: example/app\nenv: &env\n  VALUE: old\nvariants:\n  same:\n    env: *env\n";
    expect(readVariants(yaml, "same").launch).toEqual(readVariants(yaml).launch);
  });

  it("shows unresolved required consumer inputs without manufacturing values", () => {
    const preview = expandVariants({ ...minimal(), env: { INPUT: { required: true, sensitive: true } } });
    expect(preview.requiredInputs).toEqual(["INPUT"]);
    expect(preview.launch.components.default!.env!.INPUT!.default).toBeUndefined();
  });
});

describe("explicit prototype boundaries", () => {
  it.each(["name", "version", "image", "runtime", "source", "build", "commands", "components", "depends_on", "variants", "extends", "when", "provider", "environment", "resources", "platform", "host", "schedule", "secrets"])("rejects variant field %s", (field) => {
    expect(() => expandVariants({ ...minimal(), variants: { unsupported: { [field]: {} } } })).toThrow("unsupported field");
  });

  it.each([
    { components: { web: {} } }, { public: { scheme: "https" } }, { tls: true }, { provider: "docker" },
    { provides: [{ protocol: "http", port: 3000, tls: "cert" }] },
    { requires: [{ public: { endpoint: "web", scheme: "https" } }] },
    { requires: [{ host: { privileged: true } }] },
    { supports: [{ type: "certificate" }] },
    { env: { A: { default: "x", typo: true } } },
    { storage: { data: { path: "/data", typo: true } } },
    { health: { path: "/health", typo: true } },
    { requires: [{ type: "postgres", config: { provider: "x" } }] },
  ])("rejects unsupported raw contracts instead of stripping them: %j", (fields) => {
    expect(() => expandVariants({ ...minimal(), ...fields })).toThrow();
  });

  it("checks unsupported contracts in nonselected variants", () => {
    expect(() => expandVariants({ ...minimal(), variants: { hidden: { provides: [{ protocol: "http", port: 80, tls: "cert" }] } } })).toThrow("variants.hidden.provides[0].tls");
  });

  it.each(["${missing.url:-fallback}", "$secrets.missing", "$storage.missing.path", "$components.backend.url", "$app.misspelled", "$url"])("rejects undeclared references in env: %s", (value) => {
    expect(() => expandVariants({ ...minimal(), env: { VALUE: value } })).toThrow("reference");
  });

  it("rejects a clear that leaves an inherited dependency reference dangling", () => {
    expect(() => expandVariants({ ...minimal(), requires: ["postgres"], env: { DB: "$postgres.url" }, variants: { clear: { requires: [] } } })).toThrow("variants.clear.env.DB");
  });

  it("rejects a clear that leaves an inherited storage reference dangling", () => {
    expect(() => expandVariants({ ...minimal(), storage: { data: { path: "/data" } }, env: { DATA: "$storage.data.path" }, variants: { clear: { storage: {} } } })).toThrow("variants.clear.env.DATA");
  });

  it("checks local and named backing-service properties", () => {
    expect(() => expandVariants({ ...minimal(), requires: [{ type: "postgres", set_env: { DB: "$hostname" } }] })).toThrow("reference");
    expect(() => expandVariants({ ...minimal(), requires: ["postgres"], env: { DB: "$postgres.hostname" } })).toThrow("reference");
  });

  it("rejects a listener clear that leaves an inherited public URL reference dangling", () => {
    expect(() => expandVariants({ ...minimal(), provides: [{ protocol: "http", port: 80, exposed: true }], env: { URL: "$app.url" }, variants: { clear: { provides: [] } } })).toThrow("variants.clear.env.URL");
  });

  it("retains app-name references for a component without a public endpoint", () => {
    expect(expandVariants({ ...minimal(), env: { NAME: "$app.name" } }).launch.components.default!.env!.NAME!.default).toBe("$app.name");
  });

  it("refuses duplicate resources across requires and supports", () => {
    expect(() => expandVariants({ ...minimal(), requires: ["postgres"], supports: ["postgres"] })).toThrow("duplicate resource");
  });

  it("requires fallbacks when a default names an optional resource", () => {
    expect(() => expandVariants({ ...minimal(), supports: ["redis"], env: { CACHE: "$redis.url" } })).toThrow("fallback");
    expect(expandVariants({ ...minimal(), supports: ["redis"], env: { CACHE: "${redis.url:-disabled}" } }).launch.components.default!.env!.CACHE!.default).toBe("${redis.url:-disabled}");
  });

  it("rejects colliding listeners but allows TCP and UDP on the same port", () => {
    expect(() => expandVariants({ ...minimal(), provides: [{ name: "a", protocol: "http", port: 3000 }, { name: "b", protocol: "https", port: 3000 }] })).toThrow("duplicate listener");
    expect(expandVariants({ ...minimal(), provides: [{ name: "a", protocol: "tcp", port: 53 }, { name: "b", protocol: "udp", port: 53 }] }).launch.components.default!.provides).toHaveLength(2);
  });

  it("rejects repeated endpoint names even on different ports", () => {
    expect(() => expandVariants({ ...minimal(), provides: [{ name: "web", protocol: "http", port: 80 }, { name: "web", protocol: "https", port: 443 }] })).toThrow("duplicate endpoint");
  });

  it("rejects null replacement values instead of treating them as absence", () => {
    expect(() => expandVariants({ ...minimal(), variants: { empty: { env: null } } })).toThrow();
  });

  it("rejects cyclic aliases and dangerous map keys", () => {
    expect(() => readVariants("name: app\nimage: app\nenv: &env\n  CYCLE: *env\n")).toThrow("cyclic");
    expect(() => readVariants("name: app\nimage: app\nvariants:\n  constructor: {}\n")).toThrow("unsafe map key");
  });

  it("redacts preview credentials without changing source or resolving references", () => {
    const preview = expandVariants({ ...minimal(), secrets: { key: { generator: "secret" } }, env: { TOKEN: "do-not-display", VALUE: { default: "also-private", sensitive: true }, REF: "$secrets.key" }, requires: [{ type: "postgres", set_env: { PASSWORD: "literal-private" } }] });
    const redacted = redactPreview(preview);
    expect(JSON.stringify(redacted)).not.toContain("do-not-display");
    expect(JSON.stringify(redacted)).not.toContain("also-private");
    expect(JSON.stringify(redacted)).not.toContain("literal-private");
    expect(redacted.launch.components.default!.env!.REF!.default).toBe("$secrets.key");
    expect(preview.launch.components.default!.env!.TOKEN!.default).toBe("do-not-display");
  });

  it("redacts credential-bearing fallbacks, including explicitly sensitive binding targets", () => {
    const preview = expandVariants({
      ...minimal(), env: { CONNECTION: { sensitive: true } },
      requires: [{ type: "postgres", set_env: { PASSWORD: "${password:-FALLBACK_SECRET_SENTINEL}", CONNECTION: "${url:-CONNECTION_SECRET_SENTINEL}", TOKEN: "$password" } }],
    });
    const redacted = redactPreview(preview);
    expect(JSON.stringify(redacted)).not.toContain("SECRET_SENTINEL");
    expect(redacted.launch.components.default!.requires![0]!.set_env!.TOKEN).toBe("$password");
    expect(preview.launch.components.default!.requires![0]!.set_env!.PASSWORD).toContain("FALLBACK_SECRET_SENTINEL");
  });
});
