import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUpTarget } from "../resolve-target.js";

const CATALOG_DIR = join(import.meta.dirname, "../../../../catalog");

describe("resolveUpTarget", () => {
	it("resolves a catalog slug", () => {
		const result = resolveUpTarget("ghost");
		expect(result.type).toBe("catalog");
		expect(result.value).toBe("ghost");
	});

	it("resolves a local path", () => {
		const launchfile = join(CATALOG_DIR, "apps/ghost/Launchfile");
		const result = resolveUpTarget(launchfile);
		expect(result.type).toBe("local");
		expect(result.value).toBe(launchfile);
	});

	it("resolves a URL", () => {
		const url = "https://launchfile.io/apps/ghost/Launchfile";
		const result = resolveUpTarget(url);
		expect(result.type).toBe("url");
		expect(result.value).toBe(url);
	});

	it("treats multi-word slugs as catalog", () => {
		const result = resolveUpTarget("audiobookshelf");
		expect(result.type).toBe("catalog");
		expect(result.value).toBe("audiobookshelf");
	});
});

describe("resolveUpTarget path targets", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** process.exit throws so the code under test cannot continue past a refusal. */
	function trapExit(): { messages: string[] } {
		const messages: string[] = [];
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			messages.push(a.join(" "));
		});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit:${code}`);
		}) as never);
		return { messages };
	}

	function fixture(): string {
		const root = mkdtempSync(join(tmpdir(), "lf-resolve-"));
		mkdirSync(join(root, "app"));
		writeFileSync(join(root, "app", "Launchfile"), "name: x\n");
		writeFileSync(join(root, "ghost.yml"), "name: x\n");
		return root;
	}

	it("refuses a path that does not exist, naming it as typed", () => {
		const { messages } = trapExit();
		expect(() => resolveUpTarget("./does-not-exist")).toThrow("exit:1");
		expect(messages.join("\n")).toContain("./does-not-exist");
	});

	it("refuses a missing Launchfile path instead of using its parent", () => {
		const root = fixture();
		trapExit();
		expect(() => resolveUpTarget(join(root, "nope", "Launchfile"))).toThrow("exit:1");
	});

	it("refuses an existing file that is not named Launchfile", () => {
		const root = fixture();
		const { messages } = trapExit();
		expect(() => resolveUpTarget(join(root, "ghost.yml"))).toThrow("exit:1");
		expect(messages.join("\n")).toContain("ghost.yml");
	});

	it("resolves an existing directory to itself", () => {
		const root = fixture();
		const result = resolveUpTarget(join(root, "app"));
		expect(result).toEqual({ type: "local", value: join(root, "app"), dir: join(root, "app") });
	});

	it("resolves an existing Launchfile to its directory", () => {
		const root = fixture();
		const file = join(root, "app", "Launchfile");
		expect(resolveUpTarget(file)).toEqual({ type: "local", value: file, dir: join(root, "app") });
	});
});
