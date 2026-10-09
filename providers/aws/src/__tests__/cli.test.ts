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
import { KNOWN_FLAGS, parseArgs } from "../cli-args.js";

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

interface Run {
	status: number | null;
	stdout: string;
	stderr: string;
}

/** Runs the real CLI. Arguments go as an array — the shell is never invoked. */
function run(args: string[]): Run {
	const r = spawnSync("bun", ["run", cli, ...args], { encoding: "utf8" });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function translate(args: string[]): Run {
	return run(["translate", ...args]);
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

	it("honours --region on a valid invocation", () => {
		const { launchfile, out } = scratch();
		const r = translate([launchfile, "--out", out, "--region", "eu-north-1"]);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(readFileSync(join(out, "main.tf"), "utf8")).toContain(
			'region = "eu-north-1"',
		);
	});

	it("refuses an unknown flag, names it, lists the known ones, and writes nothing (#528)", () => {
		const { launchfile, out } = scratch();
		for (const [args, name] of [
			[[launchfile, "--out", out, "--regoin", "eu-north-1"], "regoin"],
			[[launchfile, "--out", out, "--regoin=eu-north-1"], "regoin"],
			[["--verbose", launchfile, "--out", out], "verbose"],
		] as const) {
			const r = translate([...args]);
			expect(r.status, args.join(" ")).toBe(1);
			expect(r.stdout, args.join(" ")).toBe("");
			expect(r.stderr, args.join(" ")).toContain(`no such flag --${name}`);
			expect(r.stderr, args.join(" ")).toContain(
				"Known flags: --out, --region, --rekey, --help",
			);
			expect(r.stderr, args.join(" ")).toContain("Nothing was written.");
			expect(existsSync(out), args.join(" ")).toBe(false);
		}
	});

	it("refuses --out and --region with no value, and writes nothing", () => {
		const { launchfile, out } = scratch();
		for (const [args, flag] of [
			[[launchfile, "--out", out, "--region"], "region"],
			[[launchfile, "--region", "--out", out], "region"],
			[[launchfile, "--out"], "out"],
		] as const) {
			const r = translate([...args]);
			expect(r.status, args.join(" ")).toBe(1);
			expect(r.stderr, args.join(" ")).toContain(
				`--${flag} needs a value: \`--${flag} <value>\`.`,
			);
			expect(r.stderr, args.join(" ")).toContain("Nothing was written.");
			expect(existsSync(out), args.join(" ")).toBe(false);
		}
	});

	it("refuses the --out=<dir> form rather than dropping it", () => {
		const { launchfile, out } = scratch();
		const r = translate([launchfile, `--out=${out}`]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`--out=${out}: write it as \`--out <value>\``);
		expect(existsSync(out)).toBe(false);
		expect(existsSync("aws-out")).toBe(false);
	});

	it("reads the Launchfile path from the first positional, wherever the flags sit (#528)", () => {
		const { launchfile, out } = scratch();
		const r = translate(["--out", out, "--region", "eu-north-1", launchfile]);
		expect(r.status).toBe(0);
		expect(readFileSync(join(out, "main.tf"), "utf8")).toContain(
			'region = "eu-north-1"',
		);
	});

	it("refuses a --flag where the command belongs", () => {
		const { launchfile, out } = scratch();
		const r = run(["--out", out, launchfile]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("the command comes before its flags");
		expect(existsSync(out)).toBe(false);
	});

	it("refuses `translate` with no Launchfile path", () => {
		const r = translate([]);
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("translate needs a Launchfile");
	});
});

describe("launchfile-aws (CLI, verbs and help)", () => {
	it("prints usage and exits 0 for a bare invocation and for --help only", () => {
		for (const args of [[], ["--help"], ["translate", "--help"]]) {
			const r = run(args);
			expect(r.status, args.join(" ")).toBe(0);
			expect(r.stdout, args.join(" ")).toContain("Usage:");
			expect(r.stderr, args.join(" ")).toBe("");
		}
	});

	it("refuses an unrecognised verb with a non-zero exit (#528)", () => {
		const { launchfile } = scratch();
		const r = run(["deploy", launchfile]);
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("Unknown command: deploy");
		expect(r.stderr).toContain("Run `launchfile-aws --help` for usage.");
	});

	it("refuses an unknown flag before honouring --help", () => {
		const r = run(["--bogus", "--help"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("no such flag --bogus");
	});
});

describe("parseArgs", () => {
	it("lists exactly the flags cli.ts reads", () => {
		expect([...KNOWN_FLAGS]).toEqual(["out", "region", "rekey", "help"]);
	});

	it("collects every --rekey in order and each single flag once", () => {
		expect(
			parseArgs([
				"translate",
				"--rekey",
				"random_uuid.a",
				"app",
				"--region",
				"eu-north-1",
				"--rekey",
				"random_password.b",
			]),
		).toEqual({
			kind: "translate",
			args: {
				file: "app",
				out: undefined,
				region: "eu-north-1",
				rekey: ["random_uuid.a", "random_password.b"],
			},
		});
	});

	it("refuses a single-value flag given twice rather than dropping one", () => {
		const r = parseArgs(["translate", "app", "--out", "a", "--out", "b"]);
		expect(r).toEqual({
			kind: "refuse",
			message: "--out is given twice; it takes one value.",
		});
	});

	it("refuses a second positional rather than ignoring it", () => {
		const r = parseArgs(["translate", "app", "other"]);
		expect(r.kind).toBe("refuse");
		if (r.kind === "refuse")
			expect(r.message).toContain("unexpected argument: other");
	});

	it("does not judge a value flag's value that starts with -- as a flag ([D-67] rule 3)", () => {
		expect(parseArgs(["translate", "app", "--out", "--bogus"])).toEqual({
			kind: "refuse",
			message: "--out needs a value: `--out <value>`.",
		});
	});

	it("reads --help only in a flag position, never as a value flag's value", () => {
		expect(parseArgs(["translate", "app", "--out", "--help"])).toEqual({
			kind: "refuse",
			message: "--out needs a value: `--out <value>`.",
		});
		expect(parseArgs(["translate", "app", "--out", "o", "--help"])).toEqual({
			kind: "help",
		});
	});

	it("refuses a bare -- with its own message", () => {
		for (const argv of [
			["translate", "--", "app"],
			["--", "translate", "app"],
		]) {
			const r = parseArgs(argv);
			expect(r.kind, argv.join(" ")).toBe("refuse");
			if (r.kind !== "refuse") continue;
			expect(r.message).toContain("`--` on its own is not read");
			expect(r.message).toContain(
				"Known flags: --out, --region, --rekey, --help",
			);
		}
	});

	it("refuses --help=<value>", () => {
		expect(parseArgs(["translate", "app", "--help=1"])).toEqual({
			kind: "refuse",
			message: "--help takes no value, e.g. --help",
		});
	});

	it("echoes an operator token with control characters stripped", () => {
		for (const r of [
			parseArgs(["translate", "app", "--bo\u001b[31mgus\nfake"]),
			parseArgs(["dep\u001b[31mloy\nfake", "app"]),
			parseArgs(["translate", "app", "--out=\u001b[31mx\nfake"]),
		]) {
			expect(r.kind).toBe("refuse");
			if (r.kind !== "refuse") continue;
			expect(r.message).not.toContain("\u001b");
			expect(r.message).toContain("\\nfake");
		}
	});
});
