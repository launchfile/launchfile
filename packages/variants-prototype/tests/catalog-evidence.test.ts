import { readFileSync } from "node:fs";
import { readLaunch, resolveExpression } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { readVariants } from "../src/variants.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const properties = { host: "database.invalid", port: 5432, name: "example", user: "example", password: "test-sentinel", url: "postgres://database.invalid/example" };

describe("catalog motivation evidence", () => {
  it("records that shipped Gitea requires PostgreSQL; the prototype baseline is a proposed edit", () => {
    const shipped = readLaunch(read("../../../catalog/apps/gitea/Launchfile")).components.default!;
    expect(shipped.requires?.some((resource) => resource.type === "postgres")).toBe(true);
    expect(shipped.supports).toBeUndefined();
    expect(shipped.env!.GITEA__database__DB_TYPE!.default).toBe("postgres");
    const candidate = readVariants(read("../examples/gitea/Launchfile")).launch.components.default!;
    expect(candidate.requires).toBeUndefined();
    expect(candidate.env!.GITEA__database__DB_TYPE!.default).toBe("sqlite3");
  });

  it.each([
    { app: "flowise", typeKey: "DATABASE_TYPE", urlKey: "DATABASE_HOST", expectedAddress: properties.host },
    { app: "mealie", typeKey: "DB_ENGINE", urlKey: "POSTGRES_URL_OVERRIDE", expectedAddress: properties.url },
  ])("confirms $app already declares optional PostgreSQL with the needed environment wiring", ({ app, typeKey, urlKey, expectedAddress }) => {
    const shipped = readLaunch(read(`../../../catalog/apps/${app}/Launchfile`)).components.default!;
    const optional = shipped.supports!.find((resource) => resource.type === "postgres")!;
    expect(shipped.requires?.some((resource) => resource.type === "postgres") ?? false).toBe(false);
    expect(optional.set_env![typeKey]).toBe("postgres");
    expect(resolveExpression(optional.set_env![urlKey]!, { resource: properties })).toBe(expectedAddress);
  });

  it("shows that existing supports/set_env can supply the candidate Gitea PostgreSQL wiring", () => {
    const alternative = readLaunch(read("../examples/gitea/supports/Launchfile")).components.default!;
    const candidate = readVariants(read("../examples/gitea/Launchfile"), "postgres").launch.components.default!;
    const optional = alternative.supports![0]!;
    const required = candidate.requires![0]!;
    const resolveBindings = (bindings: Record<string, string>) => Object.fromEntries(Object.entries(bindings).map(([key, value]) => [key, resolveExpression(value, { resource: properties })]));
    expect(resolveBindings(optional.set_env!)).toEqual(resolveBindings(required.set_env!));
    expect(alternative.env!.GITEA__database__DB_TYPE!.default).toBe("sqlite3");
    expect(alternative.provides).toEqual(candidate.provides);
    expect(alternative.storage).toEqual(candidate.storage);
    // The SQLite PATH stays declared in the alternative. Gitea's DB_TYPE selects
    // which database settings apply; this test proves wiring, never live migration.
    expect(alternative.env!.GITEA__database__PATH!.default).toBe("/data/gitea/gitea.db");
  });

  it("shows a proposed edit that preserves the exact shipped PostgreSQL baseline", () => {
    const shipped = readLaunch(read("../../../catalog/apps/gitea/Launchfile"));
    const proposed = readVariants(read("../examples/gitea/catalog-edit/Launchfile"));
    expect(proposed.launch).toEqual(shipped);
  });

  it("adds a proposed SQLite selection by explicitly removing the mandatory PostgreSQL declaration", () => {
    const proposed = readVariants(read("../examples/gitea/catalog-edit/Launchfile"), "sqlite").launch.components.default!;
    expect(proposed.requires).toEqual([]);
    expect(proposed.env!.GITEA__database__DB_TYPE!.default).toBe("sqlite3");
    expect(proposed.env!.GITEA__database__PATH!.default).toBe("/data/gitea/gitea.db");
    const shipped = readLaunch(read("../../../catalog/apps/gitea/Launchfile")).components.default!;
    expect(proposed.provides).toEqual(shipped.provides);
    expect(proposed.storage).toEqual(shipped.storage);
  });
});
