import { describe, expect, it } from "vitest";
import { readLaunch } from "../reader.js";
import {
	resolveSourcePrepareCommand,
	resolveSourceRunCommand,
} from "../source-mode.js";

function defaultComponent(launch: ReturnType<typeof readLaunch>) {
	const component = launch.components.default;
	if (!component) throw new Error("expected a default component");
	return component;
}

describe("resolveSourceRunCommand (D-38)", () => {
	it("dev-only → resolves dev", () => {
		const launch = readLaunch(`
name: acme
commands:
  dev: "bun run dev"
`);
		expect(resolveSourceRunCommand(defaultComponent(launch))?.command).toBe(
			"bun run dev",
		);
	});

	it("image + dev → dev overrides the image", () => {
		const launch = readLaunch(`
name: acme
image: ghcr.io/acme/app:1
commands:
  dev: "bun src/index.ts"
  start: "node dist/server.js"
`);
		expect(resolveSourceRunCommand(defaultComponent(launch))?.command).toBe(
			"bun src/index.ts",
		);
	});

	it("image + start, no dev → artifact mode, undefined", () => {
		const launch = readLaunch(`
name: acme
image: ghcr.io/acme/app:1
commands:
  start: "node dist/server.js"
`);
		expect(resolveSourceRunCommand(defaultComponent(launch))).toBeUndefined();
	});

	it("start-only, no image → resolves start from source", () => {
		const launch = readLaunch(`
name: acme
commands:
  start: "node server.js"
`);
		expect(resolveSourceRunCommand(defaultComponent(launch))?.command).toBe(
			"node server.js",
		);
	});

	it("neither dev, image, nor start → undefined", () => {
		const launch = readLaunch(`
name: acme
runtime: node
`);
		expect(resolveSourceRunCommand(defaultComponent(launch))).toBeUndefined();
	});

	it("preserves capture/timeout on the resolved command", () => {
		const launch = readLaunch(`
name: acme
commands:
  dev:
    command: "bun run dev"
    timeout: 30s
`);
		const resolved = resolveSourceRunCommand(defaultComponent(launch));
		expect(resolved?.command).toBe("bun run dev");
		expect(resolved?.timeout).toBe("30s");
	});
});

describe("resolveSourcePrepareCommand (D-38)", () => {
	it("install present → resolves install", () => {
		const launch = readLaunch(`
name: acme
commands:
  install: "bun install"
  build: "bun run build"
`);
		expect(resolveSourcePrepareCommand(defaultComponent(launch))?.command).toBe(
			"bun install",
		);
	});

	it("no install → falls back to build", () => {
		const launch = readLaunch(`
name: acme
commands:
  build: "bun run build"
`);
		expect(resolveSourcePrepareCommand(defaultComponent(launch))?.command).toBe(
			"bun run build",
		);
	});

	it("neither install nor build → undefined", () => {
		const launch = readLaunch(`
name: acme
runtime: node
`);
		expect(
			resolveSourcePrepareCommand(defaultComponent(launch)),
		).toBeUndefined();
	});

	it("preserves timeout on the resolved prepare command", () => {
		const launch = readLaunch(`
name: acme
commands:
  install:
    command: "bun install"
    timeout: 10m
`);
		const resolved = resolveSourcePrepareCommand(defaultComponent(launch));
		expect(resolved?.command).toBe("bun install");
		expect(resolved?.timeout).toBe("10m");
	});
});
