import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SDK_ROOT = resolve(import.meta.dirname ?? __dirname, "..", "..");
const SCRIPT = resolve(SDK_ROOT, "scripts", "check-linked-exports.ts");
const REPO_ROOT = resolve(SDK_ROOT, "..");

function run(root: string): { output: string; exitCode: number } {
	try {
		const stdout = execFileSync("bun", [SCRIPT, root], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { output: stdout, exitCode: 0 };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; status?: number };
		return {
			output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
			exitCode: e.status ?? 1,
		};
	}
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/** A minimal monorepo: root workspaces, a changeset config, one package per entry. */
function fixtureRepo(
	linked: string[],
	packages: Record<string, { name: string; exports?: unknown }>,
): string {
	const root = mkdtempSync(join(tmpdir(), "launchfile-linked-exports-"));
	writeJson(join(root, "package.json"), {
		private: true,
		workspaces: ["sdk", "providers/*"],
	});
	mkdirSync(join(root, ".changeset"));
	writeJson(join(root, ".changeset", "config.json"), { linked: [linked] });
	for (const [dir, pkg] of Object.entries(packages)) {
		mkdirSync(join(root, dir), { recursive: true });
		writeJson(join(root, dir, "package.json"), pkg);
	}
	return root;
}

const EXPORTS = {
	".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
};

describe("check-linked-exports", () => {
	it("passes on this repository", () => {
		const { output, exitCode } = run(REPO_ROOT);
		expect(output).toContain("all declare");
		expect(exitCode).toBe(0);
	});

	it("passes when every linked package declares exports", () => {
		const root = fixtureRepo(["@x/sdk", "@x/docker"], {
			sdk: { name: "@x/sdk", exports: EXPORTS },
			"providers/docker": { name: "@x/docker", exports: EXPORTS },
		});
		expect(run(root).exitCode).toBe(0);
	});

	it("fails and names each linked package without exports", () => {
		const root = fixtureRepo(["@x/sdk", "@x/docker"], {
			sdk: { name: "@x/sdk", exports: EXPORTS },
			"providers/docker": { name: "@x/docker" },
		});
		const { output, exitCode } = run(root);
		expect(exitCode).toBe(1);
		expect(output).toContain("@x/docker (providers/docker/package.json)");
		expect(output).not.toContain("@x/sdk (");
	});

	it("ignores workspace packages that are not linked", () => {
		const root = fixtureRepo(["@x/sdk"], {
			sdk: { name: "@x/sdk", exports: EXPORTS },
			"providers/aws": { name: "@x/aws" },
		});
		expect(run(root).exitCode).toBe(0);
	});

	it("exits 2 when a linked name matches no workspace package", () => {
		const root = fixtureRepo(["@x/sdk", "@x/gone"], {
			sdk: { name: "@x/sdk", exports: EXPORTS },
		});
		const { output, exitCode } = run(root);
		expect(exitCode).toBe(2);
		expect(output).toContain('"@x/gone"');
	});

	it("exits 2 when the changeset config is missing", () => {
		const root = mkdtempSync(join(tmpdir(), "launchfile-linked-exports-"));
		writeJson(join(root, "package.json"), { workspaces: ["sdk"] });
		expect(run(root).exitCode).toBe(2);
	});
});
