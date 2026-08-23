import { describe, it, expect } from "vitest";
import type { NormalizedComponent } from "@launchfile/sdk";
import { resolveSourceRunCommand } from "@launchfile/sdk";

const comp = (c: Partial<NormalizedComponent>): NormalizedComponent => c as NormalizedComponent;

/**
 * Integration check: this provider's source-mode wiring resolves through the
 * shared SDK helper (D-38, precedence dev > image > start) — see
 * sdk/src/__tests__/source-mode.test.ts for the full precedence coverage.
 */
describe("source-mode run resolution (D-38, precedence dev > image > start)", () => {
	it("dev-only → runs dev from source", () => {
		const c = comp({ commands: { dev: { command: "bun run dev" } } });
		expect(resolveSourceRunCommand(c)?.command).toBe("bun run dev");
	});

	it("image + dev → dev overrides the image, runs from source", () => {
		const c = comp({
			image: "ghcr.io/acme/app:1",
			commands: { dev: { command: "bun src/index.ts" }, start: { command: "node dist/server.js" } },
		});
		expect(resolveSourceRunCommand(c)?.command).toBe("bun src/index.ts");
	});

	it("image + start, no dev → artifact (skipped on this source-only provider)", () => {
		const c = comp({
			image: "ghcr.io/acme/app:1",
			commands: { start: { command: "node dist/server.js" } },
		});
		expect(resolveSourceRunCommand(c)).toBeUndefined();
	});

	it("start-only, no image → runs start from source", () => {
		const c = comp({ commands: { start: { command: "node server.js" } } });
		expect(resolveSourceRunCommand(c)?.command).toBe("node server.js");
	});

	it("image-only, no dev/start → artifact (skipped)", () => {
		const c = comp({ image: "ghost:5-alpine" });
		expect(resolveSourceRunCommand(c)).toBeUndefined();
	});

	it("all components image-without-dev → none source-runnable (guard errors)", () => {
		const components = {
			ghost: comp({ image: "ghost:5-alpine" }),
			api: comp({ image: "x", commands: { start: { command: "node s.js" } } }),
		};
		expect(Object.values(components).some((c) => resolveSourceRunCommand(c) !== undefined)).toBe(false);
	});
});
