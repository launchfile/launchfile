import { type ResolverContext, readLaunch } from "@launchfile/sdk";
import { describe, expect, it, vi } from "vitest";
import { planBootstraps } from "../bootstrap.js";
import { launchToCompose } from "../compose-generator.js";
import { planReleases } from "../release.js";
import { RESOURCE_PASSWORD_KEYS } from "../secrets-namespace.js";

// Every `ResolverContext` this provider builds reaches the SDK through
// `resolveExpression`, so wrapping that one export sees them all — including
// a construction site added later that no other test knows about.
const seen = vi.hoisted(() => [] as ResolverContext[]);

vi.mock("@launchfile/sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@launchfile/sdk")>();
	return {
		...actual,
		resolveExpression: (expression: string, context: ResolverContext) => {
			seen.push(context);
			return actual.resolveExpression(expression, context);
		},
	};
});

// One Launchfile that drives every context the provider builds: the
// component-level context (with `storage`, so the spread copy is taken), a
// provisioned `requires` with `set_env`, an orchestrator-supplied entry with
// `set_env`, and a release and a bootstrap command.
const launch = readLaunch(`
name: acme
secrets:
  admin_token:
    generator: secret
components:
  app:
    image: acme/app:1
    storage:
      data:
        path: /data
    requires:
      - type: postgres
        set_env:
          DB_PASSWORD: $password
      - type: redis
        set_env:
          REDIS_URL: $url
    env:
      TOKEN: $secrets.admin_token
      DATA: $storage.data.path
    commands:
      release:
        command: migrate --token $secrets.admin_token
      bootstrap:
        command: seed --token $secrets.admin_token
`);

// A pre-split state map: every backing-service password sits in `secrets`
// under its reserved key, next to the one declared name. Nothing in the
// Launchfile declares a reserved key, so none of them may resolve.
const stored: Record<string, string> = {
	admin_token: "declared-admin-token",
};
for (const key of RESOURCE_PASSWORD_KEYS)
	stored[key] = `leftover-${key}-password`;

describe("every built ResolverContext excludes backing-service passwords (#381)", () => {
	it("hands the resolver no RESOURCE_PASSWORD_KEYS from any construction site", () => {
		seen.length = 0;

		launchToCompose(launch, {
			secrets: { ...stored },
			resources: { redis: { properties: { url: "redis://cache:6379" } } },
		});
		planReleases(launch, {
			services: { app: "acme-app" },
			hostPorts: {},
			secrets: { ...stored },
		});
		planBootstraps(launch, { hostPorts: {}, secrets: { ...stored } });

		// Each family of construction site was reached: the component context
		// (carries `storage`), a `set_env` scope (carries `resource`), and the
		// release/bootstrap contexts (carry no `components` map).
		expect(seen.some((ctx) => ctx.storage !== undefined)).toBe(true);
		expect(seen.some((ctx) => ctx.resource !== undefined)).toBe(true);
		expect(seen.some((ctx) => ctx.components === undefined)).toBe(true);

		for (const ctx of seen) {
			// The narrowing keeps declared names — the map is not merely empty.
			expect(ctx.secrets?.admin_token).toBe("declared-admin-token");
			for (const key of RESOURCE_PASSWORD_KEYS) {
				expect(ctx.secrets ?? {}).not.toHaveProperty(key);
			}
		}
	});
});
