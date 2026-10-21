/**
 * `ComposeOpts.resourcePorts` (#568): run a provisioned SQL engine on a port
 * other than its default, so a docker run can catch an entry that ignores
 * `$port` and assumes the default.
 *
 * For each covered engine the port must move in four places at once — the
 * `port` property, the port in `url`, what the engine listens on, and what
 * the healthcheck probes — or the app connects to a port nothing answers on.
 * Without the option the output must not change at all.
 */

import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { launchToCompose } from "../compose-generator.js";
import {
	InvalidResourcePortError,
	RESOURCE_PORT_TYPES,
	validateResourcePorts,
} from "../resource-ports.js";

interface ComposeService {
	image: string;
	environment?: Record<string, string>;
	command?: string[];
	healthcheck?: { test: string[] };
}

function appWith(type: string): ReturnType<typeof readLaunch> {
	return readLaunch(`version: launch/v1
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
`);
}

function compose(
	type: string,
	opts: Parameters<typeof launchToCompose>[1] = {},
): { app: ComposeService; backing: ComposeService; yaml: string } {
	const result = launchToCompose(appWith(type), opts);
	const doc = parse(result.yaml) as {
		services: Record<string, ComposeService>;
	};
	const app = doc.services.portapp;
	const backing = doc.services[`portapp-${type}`];
	if (!app || !backing) throw new Error(`missing services in:\n${result.yaml}`);
	return { app, backing, yaml: result.yaml };
}

describe("ComposeOpts.resourcePorts — the non-default path", () => {
	it("postgres on 5433: port, url, PGPORT and pg_isready all move", () => {
		const { app, backing } = compose("postgres", {
			resourcePorts: { postgres: 5433 },
		});
		expect(app.environment?.DB_PORT).toBe("5433");
		expect(new URL(app.environment?.DB_URL ?? "").port).toBe("5433");
		expect(backing.environment?.PGPORT).toBe("5433");
		expect(backing.healthcheck?.test).toEqual([
			"CMD-SHELL",
			"pg_isready -U launchfile -d portapp -p 5433",
		]);
		expect(backing.command).toBeUndefined();
	});

	it("mysql on 3307: port, url, --port and a TCP healthcheck on 127.0.0.1:3307", () => {
		const { app, backing } = compose("mysql", {
			resourcePorts: { mysql: 3307 },
		});
		expect(app.environment?.DB_PORT).toBe("3307");
		expect(new URL(app.environment?.DB_URL ?? "").port).toBe("3307");
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
	});

	it("mariadb on 3307: port, url, --port and a TCP ping of 127.0.0.1:3307", () => {
		const { app, backing } = compose("mariadb", {
			resourcePorts: { mariadb: 3307 },
		});
		expect(app.environment?.DB_PORT).toBe("3307");
		expect(new URL(app.environment?.DB_URL ?? "").port).toBe("3307");
		expect(backing.command).toEqual(["--port=3307"]);
		expect(backing.healthcheck?.test).toEqual([
			"CMD-SHELL",
			"healthcheck.sh --connect --innodb_initialized && mariadb-admin ping -h 127.0.0.1 -P 3307",
		]);
	});

	it("moves only the listed engine; an unlisted one keeps its default", () => {
		const { app, backing } = compose("mysql", {
			resourcePorts: { postgres: 5433 },
		});
		expect(app.environment?.DB_PORT).toBe("3306");
		expect(backing.command).toBeUndefined();
		expect(backing.healthcheck?.test).toEqual([
			"CMD",
			"mysqladmin",
			"ping",
			"-h",
			"localhost",
		]);
	});
});

describe("ComposeOpts.resourcePorts — absent means unchanged", () => {
	// Passwords are minted per call, so both runs reuse one set to compare bytes.
	for (const type of RESOURCE_PORT_TYPES) {
		it(`${type}: the compose file is byte-identical without the option`, () => {
			const resourcePasswords = { [type]: "fixed-password" };
			const without = launchToCompose(appWith(type), {
				resourcePasswords,
			}).yaml;
			const empty = launchToCompose(appWith(type), {
				resourcePasswords,
				resourcePorts: {},
			}).yaml;
			const unlisted = launchToCompose(appWith(type), {
				resourcePasswords,
				resourcePorts: { [type === "postgres" ? "mysql" : "postgres"]: 9999 },
			}).yaml;
			expect(empty).toBe(without);
			expect(unlisted).toBe(without);
			expect(without).not.toContain("PGPORT");
			expect(without).not.toContain("--port=");
			expect(without).not.toContain("127.0.0.1");
		});
	}
});

describe("ComposeOpts.resourcePorts — refused values", () => {
	it.each([
		["zero", 0],
		["negative", -1],
		["above 65535", 65536],
		["a fraction", 5432.5],
		["NaN", Number.NaN],
		["a string", "5433"],
		["null", null],
	])("throws InvalidResourcePortError for %s", (_label, value) => {
		expect(() =>
			launchToCompose(appWith("postgres"), {
				resourcePorts: { postgres: value as unknown as number },
			}),
		).toThrow(InvalidResourcePortError);
	});

	it("names the entry and the value in the error", () => {
		try {
			validateResourcePorts({ mysql: 70000 });
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidResourcePortError);
			const e = err as InvalidResourcePortError;
			expect(e.name).toBe("InvalidResourcePortError");
			expect(e.type).toBe("mysql");
			expect(e.value).toBe(70000);
			expect(e.message).toContain("resourcePorts.mysql");
			expect(e.message).toContain("70000");
		}
	});

	it("refuses a type it has no port for instead of ignoring it", () => {
		expect(() => validateResourcePorts({ redis: 6380 })).toThrow(
			/no such backing-service type/,
		);
		expect(() => validateResourcePorts({ postgress: 5433 })).toThrow(
			InvalidResourcePortError,
		);
	});

	it("refuses a non-object", () => {
		expect(() => validateResourcePorts([5433])).toThrow(
			InvalidResourcePortError,
		);
		expect(() => validateResourcePorts("postgres=5433")).toThrow(
			InvalidResourcePortError,
		);
	});

	it("accepts the edges of the range and an explicit undefined", () => {
		expect(validateResourcePorts({ postgres: 1, mysql: 65535 })).toEqual({
			postgres: 1,
			mysql: 65535,
		});
		expect(validateResourcePorts({ postgres: undefined })).toEqual({});
		expect(validateResourcePorts(undefined)).toEqual({});
	});

	it("refuses before anything is translated", () => {
		expect(() =>
			launchToCompose(appWith("redis"), { resourcePorts: { mysql: 0 } }),
		).toThrow(InvalidResourcePortError);
	});
});
