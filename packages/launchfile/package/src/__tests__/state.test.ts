import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DeploymentIndex, DeploymentEntry } from "../state/types.js";
import { findDeployment, findBySource } from "../state/index.js";

function makeEntry(overrides: Partial<DeploymentEntry> = {}): DeploymentEntry {
	return {
		appName: "test-app",
		provider: "docker",
		source: "/Users/test/code/myapp",
		sourceType: "local",
		name: null,
		port: 3000,
		status: "up",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function makeIndex(deployments: Record<string, DeploymentEntry>): DeploymentIndex {
	return { version: 1, deployments };
}

describe("findDeployment", () => {
	it("finds by exact deployment ID", () => {
		const index = makeIndex({
			a3f2b1c: makeEntry({ appName: "ghost" }),
			e7d4c2a: makeEntry({ appName: "memos" }),
		});

		const results = findDeployment(index, "a3f2b1c");
		expect(results).toHaveLength(1);
		expect(results[0]!.entry.appName).toBe("ghost");
	});

	it("finds by app name", () => {
		const index = makeIndex({
			a3f2b1c: makeEntry({ appName: "ghost" }),
			e7d4c2a: makeEntry({ appName: "memos" }),
		});

		const results = findDeployment(index, "ghost");
		expect(results).toHaveLength(1);
		expect(results[0]!.id).toBe("a3f2b1c");
	});

	it("finds by user-assigned name", () => {
		const index = makeIndex({
			a3f2b1c: makeEntry({ appName: "ghost", name: "ghost-staging" }),
		});

		const results = findDeployment(index, "ghost-staging");
		expect(results).toHaveLength(1);
	});

	it("returns multiple matches for ambiguous app name", () => {
		const index = makeIndex({
			a3f2b1c: makeEntry({ appName: "myapp", source: "/code/myapp" }),
			e7d4c2a: makeEntry({ appName: "myapp", source: "/code/myapp-feat" }),
		});

		const results = findDeployment(index, "myapp");
		expect(results).toHaveLength(2);
	});

	it("returns empty for no match", () => {
		const index = makeIndex({
			a3f2b1c: makeEntry({ appName: "ghost" }),
		});

		const results = findDeployment(index, "nonexistent");
		expect(results).toHaveLength(0);
	});
});

describe("findBySource", () => {
	it("finds by exact source path", () => {
		const index = makeIndex({
			a3f2b1c: makeEntry({ source: "/Users/test/code/myapp" }),
			e7d4c2a: makeEntry({ source: "/Users/test/code/other" }),
		});

		const result = findBySource(index, "/Users/test/code/myapp");
		expect(result).not.toBeNull();
		expect(result!.id).toBe("a3f2b1c");
	});

	it("returns null for no match", () => {
		const index = makeIndex({
			a3f2b1c: makeEntry({ source: "/Users/test/code/myapp" }),
		});

		const result = findBySource(index, "/Users/test/code/other");
		expect(result).toBeNull();
	});
});
