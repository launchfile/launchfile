import { describe, it, expect } from "vitest";
import {
	buildResolverContext,
	resolveComponentEnv,
	generateSecrets,
} from "../env-writer.js";
import type { NormalizedComponent, Secret } from "@launchfile/sdk";
import type { ResourceProperties } from "../resources/types.js";

describe("buildResolverContext", () => {
	it("builds context from resources, ports, and secrets", () => {
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

		const ctx = buildResolverContext(resources, ports, secrets);

		expect(ctx.components?.backend).toEqual({
			url: "http://localhost:3000",
			host: "localhost",
			port: 3000,
		});
		expect(ctx.resources?.postgres?.url).toBe("postgresql://user:pass@localhost:5432/mydb");
		expect(ctx.secrets?.["jwt-secret"]).toBe("abc123");
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
		const context = buildResolverContext(resourceMap, {}, {});

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
		const context = buildResolverContext({}, {}, {});

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
		const context = buildResolverContext({}, { backend: 3000 }, {});

		const env = resolveComponentEnv(component, context, {});

		expect(env.BACKEND_URL).toBe("http://localhost:3000");
	});

	it("resolves secrets references", () => {
		const component: NormalizedComponent = {
			env: {
				SECRET_KEY: { default: "$secrets.my-key" },
			},
		};
		const context = buildResolverContext({}, {}, { "my-key": "super-secret" });

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
		const context = buildResolverContext(resourceMap, {}, {});

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
