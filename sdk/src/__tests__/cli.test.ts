import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const SDK_ROOT = resolve(import.meta.dirname ?? __dirname, "..", "..");
const CLI = resolve(SDK_ROOT, "dist", "cli.js");
const EXAMPLES = resolve(SDK_ROOT, "..", "spec", "examples");

function run(
	cliArgs: string[],
	extraEnv: Record<string, string> = {},
): { stdout: string; exitCode: number } {
	try {
		const stdout = execFileSync("node", [CLI, ...cliArgs], {
			encoding: "utf-8",
			env: { ...process.env, NO_COLOR: "1", ...extraEnv },
		});
		return { stdout, exitCode: 0 };
	} catch (err) {
		const e = err as { stdout: string; status: number };
		return { stdout: e.stdout ?? "", exitCode: e.status ?? 1 };
	}
}

describe("launchfile CLI", () => {
	describe("--help", () => {
		it("shows usage text", () => {
			const { stdout, exitCode } = run(["--help"]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("launchfile");
			expect(stdout).toContain("validate");
			expect(stdout).toContain("inspect");
			expect(stdout).toContain("schema");
		});
	});

	describe("--version", () => {
		it("prints version", () => {
			const { stdout, exitCode } = run(["--version"]);
			expect(exitCode).toBe(0);
			expect(stdout.trim()).toMatch(/^launchfile \d+\.\d+\.\d+$/);
		});
	});

	describe("validate", () => {
		it("validates minimal.yaml successfully", () => {
			const { stdout, exitCode } = run(["validate", `${EXAMPLES}/minimal.yaml`]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("my-api");
			expect(stdout).toContain("valid");
		});

		it("validates minimal-with-db.yaml successfully", () => {
			const { exitCode } = run(["validate", `${EXAMPLES}/minimal-with-db.yaml`]);
			expect(exitCode).toBe(0);
		});

		it("validates single-component.yaml successfully", () => {
			const { exitCode } = run(["validate", `${EXAMPLES}/single-component.yaml`]);
			expect(exitCode).toBe(0);
		});

		it("validates multi-component.yaml successfully", () => {
			const { stdout, exitCode } = run(["validate", `${EXAMPLES}/multi-component.yaml`]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("hedgedoc");
		});

		it("validates prebuilt-image.yaml successfully", () => {
			const { exitCode } = run(["validate", `${EXAMPLES}/prebuilt-image.yaml`]);
			expect(exitCode).toBe(0);
		});

		it("validates cron-job.yaml successfully", () => {
			const { exitCode } = run(["validate", `${EXAMPLES}/cron-job.yaml`]);
			expect(exitCode).toBe(0);
		});

		it("validates host-orchestrator.yaml successfully", () => {
			const { exitCode } = run(["validate", `${EXAMPLES}/host-orchestrator.yaml`]);
			expect(exitCode).toBe(0);
		});

		it("emits the host-capabilities summary for the new entry form (D-44)", () => {
			const { stdout, exitCode } = run([
				"validate",
				`${EXAMPLES}/host-container-runtime.yaml`,
			]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("host capabilities requested:");
			expect(stdout).toContain("container_runtime=docker (required)");
		});

		it("emits the host-capabilities summary for the legacy host block (D-44)", () => {
			const { stdout, exitCode } = run([
				"validate",
				`${EXAMPLES}/host-orchestrator.yaml`,
			]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("host capabilities requested:");
			expect(stdout).toContain("container_runtime=docker (required)");
			expect(stdout).toContain("network=host (required)");
		});

		it("fails on malformed YAML", () => {
			const { exitCode } = run(["validate", resolve(SDK_ROOT, "package.json")]);
			expect(exitCode).toBe(1);
		});

		it("fails on missing required fields", () => {
			const { exitCode } = run(["validate", resolve(SDK_ROOT, "tsconfig.json")]);
			expect(exitCode).toBe(1);
		});

		it("fails on nonexistent file", () => {
			const { exitCode } = run(["validate", "/nonexistent/Launchfile"]);
			expect(exitCode).toBe(1);
		});

		it("outputs structured JSON with --json on success", () => {
			const { stdout, exitCode } = run(["validate", `${EXAMPLES}/minimal.yaml`, "--json"]);
			expect(exitCode).toBe(0);
			const result = JSON.parse(stdout);
			expect(result.valid).toBe(true);
			expect(result.name).toBe("my-api");
			expect(result.components).toContain("default");
		});

		it("outputs structured JSON with --json on failure", () => {
			const { stdout, exitCode } = run(["validate", resolve(SDK_ROOT, "tsconfig.json"), "--json"]);
			expect(exitCode).toBe(1);
			const result = JSON.parse(stdout);
			expect(result.valid).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors.length).toBeGreaterThan(0);
		});

		it("produces no output with --quiet on success", () => {
			const { stdout, exitCode } = run(["validate", `${EXAMPLES}/minimal.yaml`, "--quiet"]);
			expect(exitCode).toBe(0);
			expect(stdout.trim()).toBe("");
		});

		it("produces no output with --quiet on failure", () => {
			const { exitCode } = run(["validate", resolve(SDK_ROOT, "tsconfig.json"), "--quiet"]);
			expect(exitCode).toBe(1);
		});

		describe("reduced-portability diagnostics (D-40, D-43)", () => {
			it("D-40 warns but stays non-fatal: exit 0, valid: true", () => {
				const { stdout, exitCode } = run([
					"validate",
					`${EXAMPLES}/prebuilt-image.yaml`,
					"--json",
				]);
				expect(exitCode).toBe(0);
				const result = JSON.parse(stdout);
				expect(result.valid).toBe(true);
				expect(result.warnings.join(" ")).toContain("D-40");
			});

			it("D-43 stays silent by default (attached read)", () => {
				const { stdout } = run(["validate", `${EXAMPLES}/minimal.yaml`, "--json"]);
				const result = JSON.parse(stdout);
				expect((result.warnings ?? []).join(" ")).not.toContain("D-43");
			});

			it("--detached surfaces D-43 for a source-needing file with no repository:", () => {
				const { stdout, exitCode } = run([
					"validate",
					`${EXAMPLES}/minimal.yaml`,
					"--detached",
					"--json",
				]);
				expect(exitCode).toBe(0);
				const result = JSON.parse(stdout);
				expect(result.valid).toBe(true);
				expect(result.warnings.join(" ")).toContain("D-43");
			});

			it("LAUNCHFILE_NO_PORTABILITY_WARNINGS silences both diagnostics", () => {
				const { stdout, exitCode } = run(
					["validate", `${EXAMPLES}/prebuilt-image.yaml`, "--detached", "--json"],
					{ LAUNCHFILE_NO_PORTABILITY_WARNINGS: "1" },
				);
				expect(exitCode).toBe(0);
				const result = JSON.parse(stdout);
				expect(result.warnings ?? []).toEqual([]);
			});

			it("an unset/empty LAUNCHFILE_NO_PORTABILITY_WARNINGS leaves the diagnostics on", () => {
				const { stdout } = run(
					["validate", `${EXAMPLES}/prebuilt-image.yaml`, "--json"],
					{ LAUNCHFILE_NO_PORTABILITY_WARNINGS: "" },
				);
				const result = JSON.parse(stdout);
				expect(result.warnings.join(" ")).toContain("D-40");
			});
		});
	});

	describe("inspect", () => {
		it("outputs valid JSON for minimal.yaml", () => {
			const { stdout, exitCode } = run(["inspect", `${EXAMPLES}/minimal.yaml`]);
			expect(exitCode).toBe(0);
			const data = JSON.parse(stdout);
			expect(data.name).toBe("my-api");
			expect(data.components).toBeDefined();
			expect(data.components.default).toBeDefined();
		});

		it("outputs normalized multi-component app", () => {
			const { stdout, exitCode } = run(["inspect", `${EXAMPLES}/multi-component.yaml`]);
			expect(exitCode).toBe(0);
			const data = JSON.parse(stdout);
			expect(data.name).toBe("hedgedoc");
			expect(data.components.backend).toBeDefined();
			expect(data.components.frontend).toBeDefined();
			expect(data.components.backend.requires[0].type).toBe("postgres");
		});

		it("fails on invalid file", () => {
			const { exitCode } = run(["inspect", resolve(SDK_ROOT, "tsconfig.json")]);
			expect(exitCode).toBe(1);
		});
	});

	describe("schema", () => {
		it("dumps valid JSON Schema", () => {
			const { stdout, exitCode } = run(["schema"]);
			expect(exitCode).toBe(0);
			const schema = JSON.parse(stdout);
			expect(schema.$schema ?? schema.$id ?? schema.type).toBeDefined();
		});
	});

	describe("unknown command", () => {
		it("exits with error for unknown command", () => {
			const { exitCode } = run(["frobnicate"]);
			expect(exitCode).toBe(1);
		});
	});
});
