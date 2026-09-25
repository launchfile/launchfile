import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../cli.ts");

const appSecret = `
version: launch/v1
name: app
runtime: node
secrets:
  session:
    generator: secret
env:
  SESSION_SECRET:
    default: $secrets.session
commands:
  start: "node server.js"
`;

function scratch(): { launchfile: string; out: string } {
	const d = mkdtempSync(join(tmpdir(), "lf-aws-cli-"));
	const launchfile = join(d, "Launchfile");
	writeFileSync(launchfile, appSecret);
	return { launchfile, out: join(d, "out") };
}

/** Runs the real CLI. Arguments go as an array — the shell is never invoked. */
function translate(args: string[]): {
	status: number | null;
	stdout: string;
	stderr: string;
} {
	const r = spawnSync("bun", ["run", cli, "translate", ...args], {
		encoding: "utf8",
	});
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("launchfile-aws translate (CLI)", () => {
	it("mints a fresh stack under D-47", () => {
		const { launchfile, out } = scratch();
		const r = translate([launchfile, "--out", out]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("0 gap(s)");
		expect(existsSync(join(out, "main.tf"))).toBe(true);
	});

	it("refuses an unparseable terraform.tfstate with no main.tf, and writes nothing", () => {
		const { launchfile, out } = scratch();
		mkdirSync(out);
		const statePath = join(out, "terraform.tfstate");
		writeFileSync(
			statePath,
			'{ "version": 4, "resources": [ {"mode":"managed","type":"random_password","name":"lf_secret_session"',
		);
		const r = translate([launchfile, "--out", out]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(statePath);
		expect(r.stderr).toContain("Nothing was written.");
		expect(r.stderr).toContain("terraform.tfstate.backup");
		expect(readdirSync(out)).toEqual(["terraform.tfstate"]);
	});

	it("refuses JSON that is not Terraform state beside a main.tf that names a minted secret, and rotates nothing", () => {
		// `{}` parses. Read as an empty state it would win over main.tf, and
		// the random_uuid recorded there would be re-minted as random_bytes.
		const hcl = 'resource "random_uuid" "lf_secret_session" {\n}\n';
		for (const json of ["{}", '{"foo":1}']) {
			const { launchfile, out } = scratch();
			mkdirSync(out);
			const statePath = join(out, "terraform.tfstate");
			writeFileSync(statePath, json);
			writeFileSync(join(out, "main.tf"), hcl);
			const r = translate([launchfile, "--out", out]);
			expect(r.status, json).toBe(1);
			expect(r.stderr, json).toContain(statePath);
			expect(r.stderr, json).toContain("does not parse as Terraform state");
			expect(r.stderr, json).toContain("Nothing was written.");
			expect(readFileSync(join(out, "main.tf"), "utf8"), json).toBe(hcl);
			expect(readdirSync(out).sort(), json).toEqual([
				"main.tf",
				"terraform.tfstate",
			]);
		}
	});

	it("mints under D-47 beside a valid empty state — a fresh stack", () => {
		const { launchfile, out } = scratch();
		mkdirSync(out);
		writeFileSync(
			join(out, "terraform.tfstate"),
			JSON.stringify({
				version: 4,
				terraform_version: "1.9.0",
				serial: 1,
				lineage: "3f1c2a4e-0000-4000-8000-000000000000",
				outputs: {},
				resources: [],
			}),
		);
		const r = translate([launchfile, "--out", out]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("0 gap(s)");
		expect(readFileSync(join(out, "main.tf"), "utf8")).toContain(
			'resource "random_bytes" "lf_secret_session"',
		);
	});

	it("refuses a --rekey with no value, and writes nothing", () => {
		const { launchfile, out } = scratch();
		for (const args of [
			[launchfile, "--out", out, "--rekey"],
			[launchfile, "--rekey", "--out", out],
		]) {
			const r = translate(args);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("--rekey needs a value");
			expect(r.stderr).toContain("Nothing was written.");
			expect(existsSync(out)).toBe(false);
		}
	});

	it("refuses the --rekey=<address> form rather than dropping it", () => {
		const { launchfile, out } = scratch();
		for (const form of ["--rekey=", "--rekey=random_uuid.lf_secret_session"]) {
			const r = translate([launchfile, "--out", out, form]);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(form);
			expect(r.stderr).toContain("--rekey <value>");
			expect(existsSync(out)).toBe(false);
		}
	});
});
