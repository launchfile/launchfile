import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	RekeyAddressError,
	readPriorStack,
	UnreadableStateError,
} from "../prior-stack.js";

function dir(): string {
	return mkdtempSync(join(tmpdir(), "lf-aws-prior-"));
}

/** A state file in the shape `terraform apply` writes: the v4 header plus `resources`. */
function state(resources: unknown[]): string {
	return JSON.stringify({
		version: 4,
		terraform_version: "1.9.0",
		serial: 1,
		lineage: "3f1c2a4e-0000-4000-8000-000000000000",
		outputs: {},
		resources,
	});
}

describe("readPriorStack", () => {
	it("reports nothing for a directory with no prior translation", () => {
		expect(readPriorStack(dir())).toBeUndefined();
		expect(readPriorStack(join(dir(), "does-not-exist"))).toBeUndefined();
	});

	it("reads the generator resource types out of a previous main.tf", () => {
		const d = dir();
		writeFileSync(
			join(d, "main.tf"),
			[
				'resource "random_password" "lf_secret_session" {',
				"  length  = 32",
				"  special = false",
				"}",
				'resource "random_uuid" "lf_secret_node_id" {',
				"}",
				'resource "aws_vpc" "main" {',
				'  cidr_block = "10.0.0.0/16"',
				"}",
			].join("\n"),
		);
		const prior = readPriorStack(d);
		expect(prior?.generators).toEqual({
			lf_secret_session: "random_password",
			lf_secret_node_id: "random_uuid",
		});
		expect(prior?.source.kind).toBe("hcl");
		expect(prior?.source.path).toBe(join(d, "main.tf"));
	});

	it("prefers terraform state — that is what apply diffs against", () => {
		const d = dir();
		writeFileSync(
			join(d, "main.tf"),
			'resource "random_bytes" "lf_secret_session" {\n  length = 32\n}\n',
		);
		writeFileSync(
			join(d, "terraform.tfstate"),
			state([
				{
					mode: "managed",
					type: "random_password",
					name: "lf_secret_session",
					instances: [{ attributes: { result: "should-never-be-read" } }],
				},
				{ mode: "data", type: "aws_ami", name: "al2023" },
			]),
		);
		const prior = readPriorStack(d);
		expect(prior?.generators).toEqual({ lf_secret_session: "random_password" });
		expect(prior?.source.kind).toBe("state");
		expect(prior?.source.path).toBe(join(d, "terraform.tfstate"));
	});

	it("reads a parsed state that holds no generator as fresh, even beside an old main.tf", () => {
		// `terraform state rm` of the only minted secret leaves exactly this
		// layout. If main.tf won here, the documented re-key steps would loop.
		const d = dir();
		writeFileSync(
			join(d, "main.tf"),
			'resource "random_password" "lf_secret_session" {\n  length = 32\n}\n',
		);
		writeFileSync(join(d, "terraform.tfstate"), state([]));
		expect(readPriorStack(d)).toBeUndefined();
	});

	it("reads a parsed state whose only random_* resource is gone as fresh", () => {
		const d = dir();
		writeFileSync(
			join(d, "main.tf"),
			'resource "random_uuid" "lf_secret_session" {\n}\n',
		);
		writeFileSync(
			join(d, "terraform.tfstate"),
			state([{ mode: "managed", type: "aws_vpc", name: "main" }]),
		);
		expect(readPriorStack(d)).toBeUndefined();
	});

	it("refuses an unparseable state file, and does not read main.tf in its place", () => {
		// The state may be newer than main.tf. Reading main.tf here would
		// re-emit whatever it recorded last, over a state that says otherwise.
		const d = dir();
		writeFileSync(join(d, "terraform.tfstate"), "{ not json");
		writeFileSync(
			join(d, "main.tf"),
			'resource "random_password" "lf_secret_session" {\n  length = 32\n}\n',
		);
		expect(() => readPriorStack(d)).toThrow(UnreadableStateError);
	});

	it("refuses an unparseable state file with no main.tf — never reads it as fresh", () => {
		// A truncated state that names a minted random_password: reading the
		// directory as fresh would mint random_bytes over it, and the next apply
		// after the state is repaired would destroy the secret.
		const d = dir();
		const statePath = join(d, "terraform.tfstate");
		writeFileSync(
			statePath,
			'{ "version": 4, "resources": [ {"mode":"managed","type":"random_password","name":"lf_secret_session"',
		);
		try {
			readPriorStack(d);
			expect.unreachable("must refuse");
		} catch (err) {
			expect(err).toBeInstanceOf(UnreadableStateError);
			const e = err as UnreadableStateError;
			expect(e.path).toBe(statePath);
			expect(e.message).toContain(statePath);
			expect(e.message).toContain("Nothing was written.");
			expect(e.message).toContain("terraform.tfstate.backup");
		}
	});

	it("refuses JSON that is not Terraform state, and does not read main.tf in its place", () => {
		// Each of these parses. None records what is minted. Reading any of them
		// as an empty state would ignore the main.tf beside it and mint over
		// the random_uuid it names.
		const shapes: Record<string, string> = {
			"empty object": "{}",
			"unrelated object": '{"foo":1}',
			"no resources array": '{"version":4,"serial":1,"lineage":"x"}',
			"resources not an array":
				'{"version":4,"serial":1,"lineage":"x","resources":{}}',
			"version not an integer":
				'{"version":"4","serial":1,"lineage":"x","resources":[]}',
			"version this reader does not understand":
				'{"version":99,"serial":1,"lineage":"x","resources":[]}',
			"no serial or lineage": '{"version":4,"resources":[]}',
			"serial not an integer":
				'{"version":4,"serial":"1","lineage":"x","resources":[]}',
			"empty lineage": '{"version":4,"serial":1,"lineage":"","resources":[]}',
			"resources holds a non-object":
				'{"version":4,"serial":1,"lineage":"x","resources":["a"]}',
			null: "null",
			"top-level array": "[]",
			"legacy v3 state":
				'{"version":3,"serial":1,"modules":[{"path":["root"],"resources":{"random_uuid.lf_secret_session":{"type":"random_uuid"}}}]}',
		};
		for (const [label, json] of Object.entries(shapes)) {
			const d = dir();
			const statePath = join(d, "terraform.tfstate");
			writeFileSync(statePath, json);
			writeFileSync(
				join(d, "main.tf"),
				'resource "random_uuid" "lf_secret_session" {\n}\n',
			);
			try {
				readPriorStack(d);
				expect.unreachable(`must refuse: ${label}`);
			} catch (err) {
				expect(err, label).toBeInstanceOf(UnreadableStateError);
				const e = err as UnreadableStateError;
				expect(e.path, label).toBe(statePath);
				expect(e.message, label).toContain("does not parse as Terraform state");
				expect(e.message, label).toContain("Nothing was written.");
			}
		}
	});

	it("reads a valid empty state on a fresh stack as fresh", () => {
		// The state `terraform apply` writes for a stack that holds nothing
		// yet, and the one `terraform state rm` leaves behind. Both mint.
		const d = dir();
		writeFileSync(
			join(d, "terraform.tfstate"),
			JSON.stringify({
				version: 4,
				terraform_version: "1.9.0",
				serial: 1,
				lineage: "3f1c2a4e-0000-4000-8000-000000000000",
				outputs: {},
				resources: [],
			}),
		);
		expect(readPriorStack(d)).toBeUndefined();
	});

	it("refuses an unparseable state file before honouring --rekey", () => {
		const d = dir();
		writeFileSync(join(d, "terraform.tfstate"), "");
		writeFileSync(
			join(d, "main.tf"),
			'resource "random_uuid" "lf_secret_session" {\n}\n',
		);
		expect(() =>
			readPriorStack(d, { rekey: ["random_uuid.lf_secret_session"] }),
		).toThrow(UnreadableStateError);
	});

	it("drops exactly the --rekey address and keeps every other record", () => {
		const d = dir();
		writeFileSync(
			join(d, "main.tf"),
			[
				'resource "random_uuid" "lf_secret_session" {',
				"}",
				'resource "random_password" "lf_secret_cookie" {',
				"  length = 32",
				"}",
			].join("\n"),
		);
		const prior = readPriorStack(d, {
			rekey: ["random_uuid.lf_secret_session"],
		});
		expect(prior?.generators).toEqual({ lf_secret_cookie: "random_password" });
		expect(prior?.source.kind).toBe("hcl");
	});

	it("reads as fresh once every record is named to --rekey", () => {
		const d = dir();
		writeFileSync(
			join(d, "main.tf"),
			'resource "random_uuid" "lf_secret_session" {\n}\n',
		);
		expect(
			readPriorStack(d, { rekey: ["random_uuid.lf_secret_session"] }),
		).toBeUndefined();
	});

	it("refuses a --rekey address the directory does not hold", () => {
		// A typo must not pass as a completed re-key: the real record would
		// still refuse or preserve, and the operator would not know why.
		const d = dir();
		writeFileSync(
			join(d, "main.tf"),
			'resource "random_uuid" "lf_secret_session" {\n}\n',
		);
		for (const address of [
			"random_uuid.lf_secret_sesion",
			"random_bytes.lf_secret_session",
			"lf_secret_session",
		]) {
			expect(() => readPriorStack(d, { rekey: [address] })).toThrow(
				RekeyAddressError,
			);
		}
		try {
			readPriorStack(d, { rekey: ["random_uuid.lf_secret_sesion"] });
			expect.unreachable("must refuse");
		} catch (err) {
			const e = err as RekeyAddressError;
			expect(e.address).toBe("random_uuid.lf_secret_sesion");
			expect(e.message).toContain("random_uuid.lf_secret_session");
			expect(e.message).toContain("Nothing was written.");
		}
	});

	it("refuses --rekey against a directory that records nothing", () => {
		expect(() =>
			readPriorStack(dir(), { rekey: ["random_uuid.lf_secret_session"] }),
		).toThrow(RekeyAddressError);
	});

	it("carries resource types only — never a minted value", () => {
		const d = dir();
		writeFileSync(
			join(d, "terraform.tfstate"),
			state([
				{
					mode: "managed",
					type: "random_password",
					name: "lf_secret_session",
					instances: [{ attributes: { result: "deadbeefdeadbeef" } }],
				},
			]),
		);
		const prior = readPriorStack(d);
		expect(JSON.stringify(prior)).not.toContain("deadbeefdeadbeef");
	});
});
