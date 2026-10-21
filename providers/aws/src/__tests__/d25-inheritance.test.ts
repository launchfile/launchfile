/**
 * D-25: when `components:` is present, top-level component fields are
 * defaults. A component that omits a field gets the top-level value; a
 * component that declares it replaces the value whole (no deep merge).
 *
 * These fixtures pin that the Terraform output carries the resolved value for
 * every inherited field this provider reads: `env` (SSM parameters),
 * `commands` and `restart` (cloud-init), and `health` (ALB target group).
 * Storage is out of scope here (#361).
 */

import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { translate } from "../translate.js";

function hclFor(yaml: string): string {
	return translate(readLaunch(yaml)).hcl;
}

/** The text of one `resource "<type>" "<name>"` block, up to the next top-level block. */
function resourceBlock(hcl: string, type: string, name: string): string {
	const start = hcl.indexOf(`resource "${type}" "${name}"`);
	if (start === -1) throw new Error(`no ${type}.${name} in output`);
	const next = hcl
		.slice(start + 1)
		.search(/\n(resource|data|output|variable|provider|terraform) /);
	return next === -1 ? hcl.slice(start) : hcl.slice(start, start + 1 + next);
}

function ssmParam(hcl: string, component: string, key: string): string {
	return resourceBlock(hcl, "aws_ssm_parameter", `d25app_${component}_${key}`);
}

const TOP_LEVEL = `version: launch/v1
name: d25app
runtime: node
env:
  SHARED_FLAG:
    default: "top"
commands:
  start: "serve --top"
health:
  path: /healthz-top
restart: on-failure
`;

const INHERIT = `${TOP_LEVEL}components:
  web:
    provides:
      - protocol: http
        port: 3000
        exposed: true
  worker:
    provides:
      - protocol: http
        port: 4000
        exposed: true
`;

const OVERRIDE = `${TOP_LEVEL}components:
  web:
    provides:
      - protocol: http
        port: 3000
        exposed: true
  worker:
    provides:
      - protocol: http
        port: 4000
        exposed: true
    env:
      WORKER_ONLY:
        default: "own"
    commands:
      start: "work --own"
    health:
      path: /healthz-own
    restart: "no"
`;

describe("aws translate — D-25 top-level component fields are inherited into components:", () => {
	it("D-25: both components omit env/commands/health/restart and carry the top-level values", () => {
		const hcl = hclFor(INHERIT);
		for (const name of ["web", "worker"]) {
			expect(ssmParam(hcl, name, "SHARED_FLAG")).toContain('value = "top"');

			const instance = resourceBlock(hcl, "aws_instance", `d25app_${name}`);
			expect(instance).toContain('ExecStart=/bin/bash -lc "serve --top"');
			expect(instance).toContain("Restart=on-failure");

			const tg = resourceBlock(hcl, "aws_lb_target_group", `d25app_${name}`);
			expect(tg).toContain('path = "/healthz-top"');
		}
	});

	it("D-25: a component's own value replaces the top-level value whole, and the sibling still inherits", () => {
		const hcl = hclFor(OVERRIDE);

		expect(ssmParam(hcl, "worker", "WORKER_ONLY")).toContain('value = "own"');
		// Shallow replacement: the component's env replaces, never merges.
		expect(() => ssmParam(hcl, "worker", "SHARED_FLAG")).toThrow();
		const worker = resourceBlock(hcl, "aws_instance", "d25app_worker");
		expect(worker).toContain('ExecStart=/bin/bash -lc "work --own"');
		expect(worker).not.toContain("serve --top");
		expect(worker).toContain("Restart=no");
		expect(
			resourceBlock(hcl, "aws_lb_target_group", "d25app_worker"),
		).toContain('path = "/healthz-own"');

		expect(ssmParam(hcl, "web", "SHARED_FLAG")).toContain('value = "top"');
		expect(() => ssmParam(hcl, "web", "WORKER_ONLY")).toThrow();
		const web = resourceBlock(hcl, "aws_instance", "d25app_web");
		expect(web).toContain('ExecStart=/bin/bash -lc "serve --top"');
		expect(web).toContain("Restart=on-failure");
		expect(resourceBlock(hcl, "aws_lb_target_group", "d25app_web")).toContain(
			'path = "/healthz-top"',
		);
	});
});
