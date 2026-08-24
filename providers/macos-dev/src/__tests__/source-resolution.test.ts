import { describe, it, expect } from "vitest";
import { type NormalizedComponent } from "@launchfile/sdk";
import { isSourceRunnable } from "../provider.js";

const comp = (c: Partial<NormalizedComponent>): NormalizedComponent => c as NormalizedComponent;

/**
 * Pins this provider's own `isSourceRunnable` guard — the fail-fast check at
 * launchUp's top and the mixed-app warning both gate on it. It wraps the
 * shared SDK resolver (D-38, precedence dev > image > start); see
 * sdk/src/__tests__/source-mode.test.ts for the full precedence table.
 */
describe("isSourceRunnable (D-38, precedence dev > image > start)", () => {
	it("dev-only → runs dev from source", () => {
		const c = comp({ commands: { dev: { command: "bun run dev" } } });
		expect(isSourceRunnable(c)).toBe(true);
	});

	it("image + dev → dev overrides the image, runs from source", () => {
		const c = comp({
			image: "ghcr.io/acme/app:1",
			commands: { dev: { command: "bun src/index.ts" }, start: { command: "node dist/server.js" } },
		});
		expect(isSourceRunnable(c)).toBe(true);
	});

	it("image + start, no dev → artifact (skipped on this source-only provider)", () => {
		const c = comp({
			image: "ghcr.io/acme/app:1",
			commands: { start: { command: "node dist/server.js" } },
		});
		expect(isSourceRunnable(c)).toBe(false);
	});

	it("start-only, no image → runs start from source", () => {
		const c = comp({ commands: { start: { command: "node server.js" } } });
		expect(isSourceRunnable(c)).toBe(true);
	});

	it("image-only, no dev/start → artifact (skipped)", () => {
		const c = comp({ image: "ghost:5-alpine" });
		expect(isSourceRunnable(c)).toBe(false);
	});

	it("all components image-without-dev → none source-runnable (guard errors)", () => {
		const components = {
			ghost: comp({ image: "ghost:5-alpine" }),
			api: comp({ image: "x", commands: { start: { command: "node s.js" } } }),
		};
		expect(Object.values(components).some(isSourceRunnable)).toBe(false);
	});
});
