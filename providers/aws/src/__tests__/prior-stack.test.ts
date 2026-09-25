import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RekeyAddressError, readPriorStack } from "../prior-stack.js";

function dir(): string {
	return mkdtempSync(join(tmpdir(), "lf-aws-prior-"));
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
			JSON.stringify({
				version: 4,
				resources: [
					{
						mode: "managed",
						type: "random_password",
						name: "lf_secret_session",
						instances: [{ attributes: { result: "should-never-be-read" } }],
					},
					{ mode: "data", type: "aws_ami", name: "al2023" },
				],
			}),
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
		writeFileSync(
			join(d, "terraform.tfstate"),
			JSON.stringify({ version: 4, resources: [] }),
		);
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
			JSON.stringify({
				version: 4,
				resources: [{ mode: "managed", type: "aws_vpc", name: "main" }],
			}),
		);
		expect(readPriorStack(d)).toBeUndefined();
	});

	it("falls back to main.tf when the state file is unparseable", () => {
		const d = dir();
		writeFileSync(join(d, "terraform.tfstate"), "{ not json");
		writeFileSync(
			join(d, "main.tf"),
			'resource "random_password" "lf_secret_session" {\n  length = 32\n}\n',
		);
		const prior = readPriorStack(d);
		expect(prior?.generators).toEqual({
			lf_secret_session: "random_password",
		});
		expect(prior?.source.kind).toBe("hcl");
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
			JSON.stringify({
				resources: [
					{
						mode: "managed",
						type: "random_password",
						name: "lf_secret_session",
						instances: [{ attributes: { result: "deadbeefdeadbeef" } }],
					},
				],
			}),
		);
		const prior = readPriorStack(d);
		expect(JSON.stringify(prior)).not.toContain("deadbeefdeadbeef");
	});
});
