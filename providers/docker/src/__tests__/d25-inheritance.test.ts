/**
 * D-25: when `components:` is present, top-level component fields are
 * defaults. A component that omits a field gets the top-level value; a
 * component that declares it replaces the value whole (no deep merge).
 *
 * These fixtures pin that the compose output carries the resolved value for
 * every inherited field this provider reads: `env`, `commands`, `health` and
 * `restart`. Storage is out of scope here (#361).
 */

import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { launchToCompose } from "../compose-generator.js";

interface Service {
	environment?: Record<string, string>;
	command?: string;
	healthcheck?: { test: string[] };
	restart?: string;
}

function services(yaml: string): Record<string, Service> {
	const result = launchToCompose(readLaunch(yaml));
	const doc = parse(result.yaml) as { services: Record<string, Service> };
	return doc.services;
}

/** The compose service generated for a component, found by name suffix. */
function service(all: Record<string, Service>, component: string): Service {
	const entry = Object.entries(all).find(([k]) => k.endsWith(`-${component}`));
	if (!entry)
		throw new Error(
			`no service for component "${component}" in ${Object.keys(all).join(", ")}`,
		);
	return entry[1];
}

const TOP_LEVEL = `version: launch/v1
name: d25app
image: example/d25app:1.0
env:
  SHARED_FLAG:
    default: "top"
commands:
  start: "serve --top"
health:
  command: "check --top"
restart: on-failure
`;

const INHERIT = `${TOP_LEVEL}components:
  web:
    provides:
      - protocol: http
        port: 3000
  worker: {}
`;

const OVERRIDE = `${TOP_LEVEL}components:
  web:
    provides:
      - protocol: http
        port: 3000
  worker:
    env:
      WORKER_ONLY:
        default: "own"
    commands:
      start: "work --own"
    health:
      command: "check --own"
    restart: always
`;

describe("docker compose — D-25 top-level component fields are inherited into components:", () => {
	it("D-25: both components omit env/commands/health/restart and carry the top-level values", () => {
		const all = services(INHERIT);
		for (const name of ["web", "worker"]) {
			const svc = service(all, name);
			expect(svc.environment?.SHARED_FLAG).toBe("top");
			expect(svc.command).toBe("serve --top");
			expect(svc.healthcheck?.test).toEqual(["CMD-SHELL", "check --top"]);
			expect(svc.restart).toBe("on-failure");
		}
	});

	it("D-25: a component's own value replaces the top-level value whole, and the sibling still inherits", () => {
		const all = services(OVERRIDE);

		const worker = service(all, "worker");
		expect(worker.environment?.WORKER_ONLY).toBe("own");
		// Shallow replacement: the component's env replaces, never merges.
		expect(worker.environment?.SHARED_FLAG).toBeUndefined();
		expect(worker.command).toBe("work --own");
		expect(worker.healthcheck?.test).toEqual(["CMD-SHELL", "check --own"]);
		expect(worker.restart).toBe("always");

		const web = service(all, "web");
		expect(web.environment?.SHARED_FLAG).toBe("top");
		expect(web.environment?.WORKER_ONLY).toBeUndefined();
		expect(web.command).toBe("serve --top");
		expect(web.healthcheck?.test).toEqual(["CMD-SHELL", "check --top"]);
		expect(web.restart).toBe("on-failure");
	});
});
