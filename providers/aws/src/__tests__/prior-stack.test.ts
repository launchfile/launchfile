import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPriorStack } from "../prior-stack.js";

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
		expect(prior?.source).toContain("main.tf");
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
		expect(prior?.source).toContain("terraform.tfstate");
	});

	it("falls back to main.tf when the state file is unparseable", () => {
		const d = dir();
		writeFileSync(join(d, "terraform.tfstate"), "{ not json");
		writeFileSync(
			join(d, "main.tf"),
			'resource "random_password" "lf_secret_session" {\n  length = 32\n}\n',
		);
		expect(readPriorStack(d)?.generators).toEqual({
			lf_secret_session: "random_password",
		});
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
