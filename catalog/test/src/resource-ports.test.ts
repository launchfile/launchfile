/**
 * `--resource-port` / `ComposeOpts.resourcePorts` in the catalog harness (#568):
 * run a provisioned postgres, mysql or mariadb on a port other than the engine
 * default, so a catalog run fails an entry that ignores `$port`.
 *
 * The harness keeps its own translator, so these tests pin it to the Docker
 * provider: for the same Launchfile and the same option, both emit the same
 * `port`, the same port in `url`, the same healthcheck and the same engine
 * flags. Without the option the harness output must not change.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readLaunch } from "../../../sdk/src/reader.ts";
import { launchToCompose as providerLaunchToCompose } from "../../../providers/docker/src/compose-generator.ts";
import {
  InvalidResourcePortError,
  RESOURCE_PORT_TYPES,
  type ResourcePorts,
} from "../../../providers/docker/src/resource-ports.ts";
import { launchToCompose } from "./launch-to-compose.ts";

interface ComposeService {
  image: string;
  environment?: Record<string, string>;
  command?: string[];
  healthcheck?: { test: string[]; start_period?: string };
}

interface Shape {
  app: ComposeService;
  backing: ComposeService;
}

const NON_DEFAULT: Readonly<Record<(typeof RESOURCE_PORT_TYPES)[number], number>> = {
  postgres: 5433,
  mysql: 3307,
  mariadb: 3307,
};

const LAUNCHFILE = (type: string): string => `version: launch/v1
name: portapp
image: nginx:alpine
provides:
  - { protocol: http, port: 80, exposed: true }
requires:
  - type: ${type}
    set_env:
      DB_HOST: $host
      DB_PORT: $port
      DB_URL: $url
`;

function shapeOf(yaml: string, type: string): Shape {
  const doc = parse(yaml) as { services: Record<string, ComposeService> };
  const app = doc.services.portapp;
  const backing = doc.services[`portapp-${type}`];
  if (!app || !backing) throw new Error(`missing services in:\n${yaml}`);
  return { app, backing };
}

function harness(type: string, resourcePorts?: ResourcePorts): Shape {
  return shapeOf(launchToCompose(readLaunch(LAUNCHFILE(type)), { resourcePorts }).yaml, type);
}

// The provider mints a random password; the harness fixes "launchfile". Reusing
// that value as the provider's saved password makes the two `url`s comparable.
function provider(type: string, resourcePorts?: ResourcePorts): Shape {
  return shapeOf(
    providerLaunchToCompose(readLaunch(LAUNCHFILE(type)), {
      resourcePasswords: { [type]: "launchfile" },
      resourcePorts,
    }).yaml,
    type,
  );
}

/** The fields the option must move, as one comparable record. */
function portShape({ app, backing }: Shape): Record<string, unknown> {
  return {
    port: app.environment?.DB_PORT,
    urlPort: new URL(app.environment?.DB_URL ?? "").port,
    healthcheck: backing.healthcheck?.test,
    startPeriod: backing.healthcheck?.start_period,
    command: backing.command,
    PGPORT: backing.environment?.PGPORT,
  };
}

describe("harness --resource-port — the non-default path", () => {
  it("postgres on 5433: port, url, PGPORT and pg_isready all move", () => {
    const { app, backing } = harness("postgres", { postgres: 5433 });
    expect(app.environment?.DB_PORT).toBe("5433");
    expect(app.environment?.DB_URL).toBe(
      "postgres://launchfile:launchfile@portapp-postgres:5433/portapp?sslmode=disable",
    );
    expect(backing.environment?.PGPORT).toBe("5433");
    expect(backing.healthcheck?.test).toEqual([
      "CMD-SHELL",
      "pg_isready -U launchfile -d portapp -p 5433",
    ]);
  });

  it("mysql on 3307: port, url, --port and a TCP healthcheck on 127.0.0.1:3307", () => {
    const { app, backing } = harness("mysql", { mysql: 3307 });
    expect(app.environment?.DB_PORT).toBe("3307");
    expect(app.environment?.DB_URL).toBe("mysql://launchfile:launchfile@portapp-mysql:3307/portapp");
    expect(backing.command).toEqual(["--port=3307"]);
    expect(backing.healthcheck?.test).toEqual([
      "CMD",
      "mysqladmin",
      "ping",
      "-h",
      "127.0.0.1",
      "-P",
      "3307",
    ]);
    expect(backing.healthcheck?.start_period).toBe("60s");
  });

  it("mariadb on 3307: port, url, --port and a TCP ping of 127.0.0.1:3307", () => {
    const { app, backing } = harness("mariadb", { mariadb: 3307 });
    expect(app.environment?.DB_PORT).toBe("3307");
    expect(app.environment?.DB_URL).toBe("mysql://launchfile:launchfile@portapp-mariadb:3307/portapp");
    expect(backing.command).toEqual(["--port=3307"]);
    expect(backing.healthcheck?.test).toEqual([
      "CMD-SHELL",
      "healthcheck.sh --connect --innodb_initialized && mariadb-admin ping -h 127.0.0.1 -P 3307",
    ]);
  });

  it("refuses an out-of-range or unknown entry the way the provider does", () => {
    const launch = readLaunch(LAUNCHFILE("postgres"));
    expect(() => launchToCompose(launch, { resourcePorts: { postgres: 0 } })).toThrow(
      InvalidResourcePortError,
    );
    expect(() => launchToCompose(launch, { resourcePorts: { postgres: Number.NaN } })).toThrow(
      InvalidResourcePortError,
    );
    expect(() =>
      launchToCompose(launch, { resourcePorts: { redis: 6380 } as unknown as ResourcePorts }),
    ).toThrow(InvalidResourcePortError);
  });
});

describe("harness --resource-port — absent means unchanged", () => {
  for (const type of RESOURCE_PORT_TYPES) {
    it(`${type}: the compose file is byte-identical without the option`, () => {
      const launch = readLaunch(LAUNCHFILE(type));
      const without = launchToCompose(launch).yaml;
      expect(launchToCompose(launch, { resourcePorts: {} }).yaml).toBe(without);
      expect(without).not.toContain("PGPORT");
      expect(without).not.toContain("--port=");
      expect(without).not.toContain("127.0.0.1");
    });
  }
});

describe("harness and provider agree (parity)", () => {
  for (const type of RESOURCE_PORT_TYPES) {
    it(`${type} on ${NON_DEFAULT[type]}: same port, url port, healthcheck and engine flags`, () => {
      const ports = { [type]: NON_DEFAULT[type] };
      expect(portShape(harness(type, ports))).toEqual(portShape(provider(type, ports)));
      expect(harness(type, ports).app.environment?.DB_URL).toBe(
        provider(type, ports).app.environment?.DB_URL,
      );
    });

    it(`${type} on its default: same port, url port, healthcheck and engine flags`, () => {
      expect(portShape(harness(type))).toEqual(portShape(provider(type)));
    });
  }
});

describe("test-app.ts --resource-port (end to end, dry run)", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));

  function testApp(args: string[]): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolvePromise, reject) => {
      const proc = spawn("bun", ["run", "src/test-app.ts", ...args], { cwd });
      let out = "";
      let err = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString();
      });
      proc.on("error", reject);
      proc.on("close", (code) => resolvePromise({ code: code ?? -1, out, err }));
    });
  }

  it("runs miniflux's postgres on 5433 and hands the app that port", async () => {
    const { code, out } = await testApp(["miniflux", "--dry-run", "--resource-port", "postgres=5433"]);
    expect(code).toBe(0);
    expect(out).toContain("Backing-service container ports: postgres=5433");
    const marker = "--- Dry run: compose file written, not launching ---\n";
    const yaml = out.slice(out.indexOf(marker) + marker.length);
    const doc = parse(yaml) as { services: Record<string, ComposeService> };
    expect(doc.services["miniflux-postgres"]?.environment?.PGPORT).toBe("5433");
    expect(doc.services.miniflux?.environment?.DATABASE_URL).toContain("miniflux-postgres:5433/");
  });

  it("accepts the --flag=value spelling", async () => {
    const { code, out } = await testApp(["miniflux", "--dry-run", "--resource-port=postgres=5433"]);
    expect(code).toBe(0);
    expect(out).toContain('PGPORT: "5433"');
  });

  it("exits 1 naming the entry for a port out of range", async () => {
    const { code, err } = await testApp(["miniflux", "--dry-run", "--resource-port", "postgres=70000"]);
    expect(code).toBe(1);
    expect(err).toContain("resourcePorts.postgres");
    expect(err).toContain("70000");
  });

  it("exits 1 for a pair without a port", async () => {
    const { code, err } = await testApp(["miniflux", "--dry-run", "--resource-port", "postgres"]);
    expect(code).toBe(1);
    expect(err).toContain("--resource-port needs <type>=<port>");
  });
});
