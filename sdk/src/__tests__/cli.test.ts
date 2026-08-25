import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

/**
 * Write a Launchfile to a temp file and return its path. The legacy `host:`
 * block no longer appears in `spec/examples/` (D-58 migrated the gallery off
 * it), so legacy-path CLI coverage lives on inline fixtures instead.
 */
function fixture(yaml: string): string {
	const dir = mkdtempSync(join(tmpdir(), "launchfile-cli-"));
	const path = join(dir, "Launchfile");
	writeFileSync(path, yaml, "utf-8");
	return path;
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
				fixture(
					"version: launch/v1\nname: legacy\nimage: app:1\nhost:\n  docker: required\n  network: host\n",
				),
			]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("host capabilities requested:");
			expect(stdout).toContain("container_runtime=docker (required)");
			expect(stdout).toContain("network=host (required)");
		});

		it("emits the host-capabilities summary for the migrated example (D-58)", () => {
			const { stdout, exitCode } = run([
				"validate",
				`${EXAMPLES}/host-orchestrator.yaml`,
			]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("host capabilities requested:");
			expect(stdout).toContain("container_runtime=docker (required)");
			expect(stdout).toContain("network=host (required)");
			expect(stdout).toContain("filesystem=read-write (required)");
		});

		it("lists content: operator volumes in the privilege summary (D-50)", () => {
			const { stdout, exitCode } = run([
				"validate",
				`${EXAMPLES}/operator-content.yaml`,
			]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("operator-supplied storage:");
			expect(stdout).toContain("music");
			// The provider-owned sibling volume is not part of the summary.
			expect(stdout).not.toMatch(/operator-supplied storage:.*data/);
		});

		it("reports operatorStorage in JSON output, component-prefixed outside default (D-50)", () => {
			const { stdout, exitCode } = run([
				"validate",
				fixture(
					"version: launch/v1\nname: media\ncomponents:\n  web:\n    image: app:1\n" +
						"    storage:\n      music:\n        path: /music\n        content: operator\n" +
						"      data:\n        path: /data\n",
				),
				"--json",
			]);
			expect(exitCode).toBe(0);
			const result = JSON.parse(stdout);
			expect(result.valid).toBe(true);
			expect(result.operatorStorage).toEqual(["web.music"]);
		});

		it("omits operatorStorage when no volume carries the marker", () => {
			const { stdout } = run([
				"validate",
				`${EXAMPLES}/storage-paths.yaml`,
				"--json",
			]);
			expect(JSON.parse(stdout).operatorStorage).toBeUndefined();
		});

		it("warns on persistent: false beside content: operator (D-50)", () => {
			const { stdout, exitCode } = run([
				"validate",
				fixture(
					"version: launch/v1\nname: media\nimage: app:1\n" +
						"storage:\n  music:\n    path: /music\n    content: operator\n    persistent: false\n",
				),
				"--json",
			]);
			expect(exitCode).toBe(0);
			const result = JSON.parse(stdout);
			expect(result.valid).toBe(true);
			expect(result.warnings.join(" ")).toContain("contradiction");
			expect(result.warnings.join(" ")).toContain("D-50");
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

		describe("unrecognized storage keys (#239)", () => {
			it("warns but stays non-fatal for a component storage entry: exit 0, valid: true", () => {
				const { stdout, exitCode } = run([
					"validate",
					fixture(
						"version: launch/v1\nname: acme\ncomponents:\n  caddy:\n    image: caddy:2\n" +
							"    storage:\n      caddyfile:\n        path: /etc/caddy\n" +
							"        source: ./caddy\n        readonly: true\n",
					),
					"--json",
				]);
				expect(exitCode).toBe(0);
				const result = JSON.parse(stdout);
				expect(result.valid).toBe(true);
				expect(result.warnings).toContain(
					'storage "caddy.caddyfile": unrecognized keys "source", "readonly" ' +
						"(known: path, size, persistent, content) — unknown keys are ignored and " +
						"will not affect deployment",
				);
			});

			it("warns for the top-level single-component storage spelling", () => {
				const { stdout, exitCode } = run([
					"validate",
					fixture(
						"version: launch/v1\nname: acme\nimage: app:1\n" +
							"storage:\n  data:\n    path: /data\n    mode: \"0700\"\n",
					),
					"--json",
				]);
				expect(exitCode).toBe(0);
				const result = JSON.parse(stdout);
				expect(result.valid).toBe(true);
				expect(result.warnings.join(" ")).toContain('storage "data"');
				expect(result.warnings.join(" ")).toContain('"mode"');
			});

			it("stays silent for storage entries using only recognized keys", () => {
				const { stdout, exitCode } = run(
					[
						"validate",
						fixture(
							"version: launch/v1\nname: acme\nimage: app:1\n" +
								"storage:\n  data:\n    path: /data\n    size: 10Gi\n    persistent: true\n",
						),
						"--json",
					],
					// Silence the unrelated D-40 prebuilt-image diagnostic so an empty
					// warnings list proves the storage check specifically stayed quiet.
					{ LAUNCHFILE_NO_PORTABILITY_WARNINGS: "1" },
				);
				expect(exitCode).toBe(0);
				const result = JSON.parse(stdout);
				expect(result.valid).toBe(true);
				expect(result.warnings ?? []).toEqual([]);
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


describe("launchfile validate — deprecation reporting (D-58/D-42)", () => {
	const LEGACY = fixture(
		"version: launch/v1\nname: legacy\nimage: app:1\nhost:\n  docker: required\n  network: host\n",
	);

	// D-42 capability (a) must be machine-readable. A prose warning string
	// does not satisfy it, so the findings get their own JSON field.
	it("emits structured deprecations in --json output", () => {
		const { stdout, exitCode } = run(["validate", LEGACY, "--json"]);
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout);
		expect(result.valid).toBe(true);
		expect(Array.isArray(result.deprecations)).toBe(true);
		const docker = result.deprecations.find(
			(d: { path: string }) => d.path === "components.default.host.docker",
		);
		expect(docker).toEqual({
			path: "components.default.host.docker",
			deprecated_in: "launch/v1",
			removed_in: "launch/v2",
			replacement: "requires[].host.container_runtime",
			hint: expect.stringContaining("container_runtime: docker"),
		});
	});

	it("stays valid and exits 0 on a deprecated file (deprecation warns, never breaks)", () => {
		const { stdout, exitCode } = run(["validate", LEGACY]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("is valid");
	});

	it("omits the deprecations field entirely for a file using the entry form", () => {
		const path = fixture(
			"version: launch/v1\nname: modern\nimage: app:1\nrequires:\n  - host: { container_runtime: docker }\n",
		);
		const { stdout, exitCode } = run(["validate", path, "--json"]);
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout).deprecations).toBeUndefined();
	});

	// The published gallery must never teach a deprecated form.
	it("reports zero deprecations for every spec/examples file", () => {
		const files = readdirSync(EXAMPLES).filter((f) => /\.ya?ml$/.test(f));
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const { stdout, exitCode } = run([
				"validate",
				`${EXAMPLES}/${file}`,
				"--json",
			]);
			expect(exitCode, file).toBe(0);
			expect(JSON.parse(stdout).deprecations, file).toBeUndefined();
		}
	});
});
