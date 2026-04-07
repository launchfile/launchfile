import { describe, it, expect } from "vitest";
import { detectPackageManager } from "../lockfile-detect.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("detectPackageManager", () => {
	it("returns null for empty directory", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lf-test-"));
		try {
			const pm = await detectPackageManager(dir);
			expect(pm).toBeNull();
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it("detects bun from bun.lockb", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lf-test-"));
		try {
			await writeFile(join(dir, "bun.lockb"), "");
			const pm = await detectPackageManager(dir);
			expect(pm?.name).toBe("bun");
			expect(pm?.installCommand).toBe("bun install");
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it("detects yarn from yarn.lock", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lf-test-"));
		try {
			await writeFile(join(dir, "yarn.lock"), "");
			const pm = await detectPackageManager(dir);
			expect(pm?.name).toBe("yarn");
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it("detects pnpm from pnpm-lock.yaml", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lf-test-"));
		try {
			await writeFile(join(dir, "pnpm-lock.yaml"), "");
			const pm = await detectPackageManager(dir);
			expect(pm?.name).toBe("pnpm");
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it("detects bundler from Gemfile.lock", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lf-test-"));
		try {
			await writeFile(join(dir, "Gemfile.lock"), "");
			const pm = await detectPackageManager(dir);
			expect(pm?.name).toBe("bundler");
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it("prefers bun over yarn when both present", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lf-test-"));
		try {
			await writeFile(join(dir, "bun.lockb"), "");
			await writeFile(join(dir, "yarn.lock"), "");
			const pm = await detectPackageManager(dir);
			expect(pm?.name).toBe("bun");
		} finally {
			await rm(dir, { recursive: true });
		}
	});
});
