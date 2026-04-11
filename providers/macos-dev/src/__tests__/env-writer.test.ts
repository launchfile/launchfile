import { describe, it, expect } from "vitest";
import {
	buildResolverContext,
	computeAppProperties,
	resolveComponentEnv,
	generateSecrets,
} from "../env-writer.js";
import { resolveExpression, type NormalizedComponent, type NormalizedLaunch, type Secret } from "@launchfile/sdk";
import type { ResourceProperties } from "../resources/types.js";

const NO_APP: Record<string, string | number> = {};

describe("buildResolverContext", () => {
	it("builds context from resources, ports, secrets, and app properties", () => {
		const resources: Record<string, ResourceProperties> = {
			postgres: {
				url: "postgresql://user:pass@localhost:5432/mydb",
				host: "localhost",
				port: 5432,
				user: "user",
				password: "pass",
				name: "mydb",
			},
		};
		const ports = { backend: 3000, frontend: 3001 };
		const secrets = { "jwt-secret": "abc123" };
		const app = { name: "my-app", host: "localhost", port: 3000, url: "http://localhost:3000" };

		const ctx = buildResolverContext(resources, ports, secrets, app);

		expect(ctx.components?.backend).toEqual({
			url: "http://localhost:3000",
			host: "localhost",
			port: 3000,
		});
		expect(ctx.resources?.postgres?.url).toBe("postgresql://user:pass@localhost:5432/mydb");
		expect(ctx.secrets?.["jwt-secret"]).toBe("abc123");
		expect(ctx.app?.url).toBe("http://localhost:3000");
		expect(ctx.app?.name).toBe("my-app");
	});
});

describe("computeAppProperties (D-33)", () => {
	const baseLaunch = (overrides: Partial<NormalizedLaunch>): NormalizedLaunch =>
		({
			name: "my-app",
			components: {},
			...overrides,
		}) as NormalizedLaunch;

	it("uses the first exposed component's port for $app.port and $app.url", () => {
		const launch = baseLaunch({
			components: {
				default: {
					provides: [{ protocol: "http", port: 3000, exposed: true }],
				} as NormalizedComponent,
			},
		});
		const app = computeAppProperties(launch, { default: 10042 });
		expect(app.name).toBe("my-app");
		expect(app.host).toBe("localhost");
		expect(app.port).toBe(10042);
		expect(app.url).toBe("http://localhost:10042");
	});

	it("picks the first exposed component in declaration order for multi-component apps", () => {
		const launch = baseLaunch({
			components: {
				api: {
					provides: [{ protocol: "http", port: 4000, exposed: true }],
				} as NormalizedComponent,
				worker: {
					provides: [],
				} as unknown as NormalizedComponent,
				ui: {
					provides: [{ protocol: "http", port: 5000, exposed: true }],
				} as NormalizedComponent,
			},
		});
		const app = computeAppProperties(launch, { api: 10043, ui: 10044 });
		// Picks "api" because it's first in declaration order with exposed: true.
		expect(app.port).toBe(10043);
		expect(app.url).toBe("http://localhost:10043");
	});

	it("returns port 0 and empty url when no component is exposed", () => {
		const launch = baseLaunch({
			components: {
				worker: {
					provides: [],
				} as unknown as NormalizedComponent,
			},
		});
		const app = computeAppProperties(launch, {});
		expect(app.port).toBe(0);
		expect(app.url).toBe("");
		expect(app.name).toBe("my-app");
	});

	// End-to-end: a component env var that uses $app.url resolves to the
	// computed app URL. This is the contract that makes Firefly III's
	// `APP_URL: default: $app.url` actually work end-to-end on macos-dev.
	it("$app.url in component env defaults resolves to the computed URL", () => {
		const launch = baseLaunch({
			components: {
				default: {
					provides: [{ protocol: "http", port: 3000, exposed: true }],
					env: { PUBLIC_URL: { default: "$app.url" } },
				} as NormalizedComponent,
			},
		});
		const app = computeAppProperties(launch, { default: 10042 });
		const ctx = buildResolverContext({}, { default: 10042 }, {}, app);
		const env = resolveComponentEnv(launch.components.default!, ctx, {});
		expect(env.PUBLIC_URL).toBe("http://localhost:10042");
	});
});

describe("resolveComponentEnv", () => {
	it("resolves set_env from requires", () => {
		const component: NormalizedComponent = {
			requires: [
				{
					type: "postgres",
					set_env: {
						DATABASE_URL: "$url",
						DB_HOST: "$host",
					},
				},
			],
		};
		const resourceMap: Record<string, ResourceProperties> = {
			postgres: {
				url: "postgresql://user:pass@localhost:5432/mydb",
				host: "localhost",
				port: 5432,
			},
		};
		const context = buildResolverContext(resourceMap, {}, {}, NO_APP);

		const env = resolveComponentEnv(component, context, resourceMap);

		expect(env.DATABASE_URL).toBe("postgresql://user:pass@localhost:5432/mydb");
		expect(env.DB_HOST).toBe("localhost");
	});

	it("resolves component-level env defaults", () => {
		const component: NormalizedComponent = {
			env: {
				PORT: { default: "8080" },
				LOG_LEVEL: { default: "info" },
			},
		};
		const context = buildResolverContext({}, {}, {}, NO_APP);

		const env = resolveComponentEnv(component, context, {});

		expect(env.PORT).toBe("8080");
		expect(env.LOG_LEVEL).toBe("info");
	});

	it("resolves cross-component references", () => {
		const component: NormalizedComponent = {
			env: {
				BACKEND_URL: { default: "$components.backend.url" },
			},
		};
		const context = buildResolverContext({}, { backend: 3000 }, {}, NO_APP);

		const env = resolveComponentEnv(component, context, {});

		expect(env.BACKEND_URL).toBe("http://localhost:3000");
	});

	it("resolves secrets references", () => {
		const component: NormalizedComponent = {
			env: {
				SECRET_KEY: { default: "$secrets.my-key" },
			},
		};
		const context = buildResolverContext({}, {}, { "my-key": "super-secret" }, NO_APP);

		const env = resolveComponentEnv(component, context, {});

		expect(env.SECRET_KEY).toBe("super-secret");
	});

	it("set_env takes precedence over component env", () => {
		const component: NormalizedComponent = {
			requires: [
				{
					type: "postgres",
					set_env: { DATABASE_URL: "$url" },
				},
			],
			env: {
				DATABASE_URL: { default: "fallback" },
			},
		};
		const resourceMap: Record<string, ResourceProperties> = {
			postgres: {
				url: "postgresql://real-url",
				host: "localhost",
				port: 5432,
			},
		};
		const context = buildResolverContext(resourceMap, {}, {}, NO_APP);

		const env = resolveComponentEnv(component, context, resourceMap);

		expect(env.DATABASE_URL).toBe("postgresql://real-url");
	});
});

describe("generateSecrets", () => {
	it("generates new secrets", async () => {
		const defs: Record<string, Secret> = {
			"jwt-secret": { generator: "secret" },
			"app-uuid": { generator: "uuid" },
		};

		const secrets = await generateSecrets(defs, {});

		expect(secrets["jwt-secret"]).toBeTruthy();
		expect(secrets["app-uuid"]).toMatch(/^[0-9a-f-]+$/);
	});

	it("reuses existing secrets", async () => {
		const defs: Record<string, Secret> = {
			"jwt-secret": { generator: "secret" },
		};
		const existing = { "jwt-secret": "keep-this" };

		const secrets = await generateSecrets(defs, existing);

		expect(secrets["jwt-secret"]).toBe("keep-this");
	});
});
