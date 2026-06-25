import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractToolchainVersions } from "../toolchain.js";

// Each test builds a throwaway repo dir under the OS temp dir and writes the
// fixture files it needs inline, then cleans up. This keeps fixtures local to
// the assertion that depends on them and avoids a shared on-disk fixtures tree.
const created: string[] = [];

async function makeRepo(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "lf-toolchain-"));
	created.push(dir);
	for (const [name, content] of Object.entries(files)) {
		await writeFile(join(dir, name), content, "utf-8");
	}
	return dir;
}

afterEach(async () => {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	}
});

describe("extractToolchainVersions", () => {
	describe("bun", () => {
		it("discovers bun from package.json packageManager (Corepack form)", async () => {
			const repo = await makeRepo({
				"package.json": JSON.stringify({ packageManager: "bun@1.3.13" }),
			});
			const result = await extractToolchainVersions(repo);
			expect(result.bun).toBe("bun@1.3.13");
			expect(result.sources.bun).toEqual({
				file: "package.json",
				field: "packageManager",
				raw: "bun@1.3.13",
			});
		});

		it("discovers bun from engines.bun when no packageManager", async () => {
			const repo = await makeRepo({
				"package.json": JSON.stringify({ engines: { bun: ">=1.3.13" } }),
			});
			const result = await extractToolchainVersions(repo);
			expect(result.bun).toBe(">=1.3.13");
			expect(result.sources.bun?.field).toBe("engines.bun");
			expect(result.sources.bun?.raw).toBe(">=1.3.13");
		});

		it("prefers packageManager over engines.bun when both are present", async () => {
			const repo = await makeRepo({
				"package.json": JSON.stringify({
					packageManager: "bun@1.3.13",
					engines: { bun: ">=1.0.0" },
				}),
			});
			const result = await extractToolchainVersions(repo);
			expect(result.bun).toBe("bun@1.3.13");
			expect(result.sources.bun?.field).toBe("packageManager");
		});

		it("discovers bun from .bun-version when no package.json signals", async () => {
			const repo = await makeRepo({ ".bun-version": "1.2.0\n" });
			const result = await extractToolchainVersions(repo);
			expect(result.bun).toBe("1.2.0");
			expect(result.sources.bun?.file).toBe(".bun-version");
		});
	});

	describe("node", () => {
		it("discovers node from .nvmrc with the leading v kept in raw", async () => {
			const repo = await makeRepo({ ".nvmrc": "v20.11.0\n" });
			const result = await extractToolchainVersions(repo);
			expect(result.node).toBe("v20.11.0");
			expect(result.sources.node).toEqual({ file: ".nvmrc", raw: "v20.11.0" });
		});

		it("discovers node from .tool-versions nodejs line", async () => {
			const repo = await makeRepo({ ".tool-versions": "nodejs 20.11.0\n" });
			const result = await extractToolchainVersions(repo);
			expect(result.node).toBe("20.11.0");
			expect(result.sources.node?.file).toBe(".tool-versions");
			expect(result.sources.node?.field).toBe("node");
		});

		it("prefers engines.node over .nvmrc", async () => {
			const repo = await makeRepo({
				"package.json": JSON.stringify({ engines: { node: ">=18" } }),
				".nvmrc": "20.11.0",
			});
			const result = await extractToolchainVersions(repo);
			expect(result.node).toBe(">=18");
			expect(result.sources.node?.field).toBe("engines.node");
		});
	});

	describe("python", () => {
		it("discovers python from .python-version", async () => {
			const repo = await makeRepo({ ".python-version": "3.12.1\n" });
			const result = await extractToolchainVersions(repo);
			expect(result.python).toBe("3.12.1");
			expect(result.sources.python?.file).toBe(".python-version");
		});

		it("discovers python from pyproject requires-python", async () => {
			const repo = await makeRepo({
				"pyproject.toml": '[project]\nname = "x"\nrequires-python = ">=3.11"\n',
			});
			const result = await extractToolchainVersions(repo);
			expect(result.python).toBe(">=3.11");
			expect(result.sources.python?.field).toBe("project.requires-python");
		});

		it("discovers python from poetry dependencies when requires-python absent", async () => {
			const repo = await makeRepo({
				"pyproject.toml": '[tool.poetry.dependencies]\npython = "^3.10"\n',
			});
			const result = await extractToolchainVersions(repo);
			expect(result.python).toBe("^3.10");
			expect(result.sources.python?.field).toBe(
				"tool.poetry.dependencies.python",
			);
		});
	});

	describe("ruby", () => {
		it("discovers ruby from .ruby-version", async () => {
			const repo = await makeRepo({ ".ruby-version": "3.2.0\n" });
			const result = await extractToolchainVersions(repo);
			expect(result.ruby).toBe("3.2.0");
			expect(result.sources.ruby?.file).toBe(".ruby-version");
		});

		it("discovers ruby from a Gemfile ruby directive", async () => {
			const repo = await makeRepo({
				Gemfile: "source 'https://rubygems.org'\nruby '3.2.0'\n",
			});
			const result = await extractToolchainVersions(repo);
			expect(result.ruby).toBe("3.2.0");
			expect(result.sources.ruby?.file).toBe("Gemfile");
		});
	});

	describe("go", () => {
		it("discovers go from a go.mod go directive", async () => {
			const repo = await makeRepo({
				"go.mod": "module example.com/x\n\ngo 1.22\n",
			});
			const result = await extractToolchainVersions(repo);
			expect(result.go).toBe("1.22");
			expect(result.sources.go).toEqual({
				file: "go.mod",
				field: "go",
				raw: "1.22",
			});
		});
	});

	describe(".tool-versions multi-tool", () => {
		it("populates several languages from one .tool-versions file", async () => {
			const repo = await makeRepo({
				".tool-versions": [
					"# managed by mise",
					"nodejs 20.11.0",
					"python 3.12.1",
					"ruby 3.2.0",
					"golang 1.22.0",
					"java temurin-21.0.2",
					"rust 1.76.0",
					"elixir 1.16.1",
					"",
				].join("\n"),
			});
			const result = await extractToolchainVersions(repo);
			expect(result.node).toBe("20.11.0");
			expect(result.python).toBe("3.12.1");
			expect(result.ruby).toBe("3.2.0");
			expect(result.go).toBe("1.22.0");
			expect(result.java).toBe("temurin-21.0.2");
			expect(result.rust).toBe("1.76.0");
			expect(result.elixir).toBe("1.16.1");
			expect(result.sources.go?.file).toBe(".tool-versions");
		});
	});

	describe("edge cases", () => {
		it("returns an empty sources map for a repo with no toolchain files", async () => {
			const repo = await makeRepo({});
			const result = await extractToolchainVersions(repo);
			expect(result).toEqual({ sources: {} });
		});

		it("skips a malformed package.json instead of throwing", async () => {
			const repo = await makeRepo({
				"package.json": "{ this is not valid json ",
				".bun-version": "1.2.0",
			});
			const result = await extractToolchainVersions(repo);
			// The bad package.json is ignored; the next bun source is used.
			expect(result.bun).toBe("1.2.0");
			expect(result.sources.bun?.file).toBe(".bun-version");
		});
	});
});
