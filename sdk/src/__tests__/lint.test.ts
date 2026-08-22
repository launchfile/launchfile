import { describe, expect, it } from "vitest";
import { lintLaunch } from "../lint.js";
import { readLaunch } from "../reader.js";

describe("lintLaunch — conflicting same-name resources (Q1)", () => {
	it("warns when the same name declares a divergent version", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    requires:
      - { type: postgres, version: ">=15" }
  worker:
    image: worker:latest
    requires:
      - { type: postgres, version: ">=16" }
`);
		const warnings = lintLaunch(launch);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"postgres"');
		expect(warnings[0]).toContain("version");
	});

	it("warns when the same name declares a divergent config", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    requires:
      - { type: postgres, config: { storage: "10Gi" } }
  worker:
    image: worker:latest
    requires:
      - { type: postgres, config: { storage: "20Gi" } }
`);
		const warnings = lintLaunch(launch);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("config");
	});

	it("warns when a custom name binds divergent types", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    requires:
      - { name: cache, type: redis }
  worker:
    image: worker:latest
    requires:
      - { name: cache, type: memcache }
`);
		const warnings = lintLaunch(launch);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"cache"');
		expect(warnings[0]).toContain("type");
	});

	it("does NOT warn when the same name has an identical definition", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    requires:
      - { type: postgres, version: ">=15" }
  worker:
    image: worker:latest
    requires:
      - { type: postgres, version: ">=15" }
`);
		expect(lintLaunch(launch)).toEqual([]);
	});

	it("treats config with reordered keys as identical (no warning)", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    requires:
      - { type: postgres, config: { a: "1", b: "2" } }
  worker:
    image: worker:latest
    requires:
      - { type: postgres, config: { b: "2", a: "1" } }
`);
		expect(lintLaunch(launch)).toEqual([]);
	});

	it("does NOT warn when different names share a type", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    requires:
      - { name: primary-db, type: postgres, version: ">=15" }
  analytics:
    image: analytics:latest
    requires:
      - { name: analytics-db, type: postgres, version: ">=16" }
`);
		expect(lintLaunch(launch)).toEqual([]);
	});

	it("reports multiple divergent fields together", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    requires:
      - { type: postgres, version: ">=15", config: { storage: "10Gi" } }
  worker:
    image: worker:latest
    requires:
      - { type: postgres, version: ">=16", config: { storage: "20Gi" } }
`);
		const warnings = lintLaunch(launch);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("config");
		expect(warnings[0]).toContain("version");
	});

	it("detects conflicts that mix requires and supports", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    requires:
      - { type: redis, version: ">=7" }
    supports:
      - { type: redis, version: ">=6" }
`);
		const warnings = lintLaunch(launch);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"redis"');
	});
});

describe("host-capability marker advisory — product spellings (D-44)", () => {
	const lint = (body: string) =>
		lintLaunch(readLaunch(`version: launch/v1\nname: p\nimage: x\n${body}`));

	it("flags an unmarked `type: docker` entry", () => {
		expect(lint("requires:\n  - type: docker\n").join()).toContain(
			"looks like a host capability",
		);
	});

	it("suggests the interface name, not the product name", () => {
		// `host: { docker: ... }` would keep the marker but re-break P-1, which
		// is the half of D-44 that matters most.
		const w = lint("requires:\n  - type: docker\n").join();
		expect(w).toContain("container_runtime: docker");
		expect(w).not.toContain("{ docker: ...");
	});

	it("maps podman to the same interface", () => {
		expect(lint("requires:\n  - type: podman\n").join()).toContain(
			"container_runtime: docker",
		);
	});

	it("stays silent for a properly marked capability entry", () => {
		expect(lint("requires:\n  - host: { container_runtime: docker }\n")).toEqual([]);
	});

	it("stays silent for an ordinary backing service", () => {
		expect(lint("requires:\n  - postgres\n")).toEqual([]);
	});
});

describe("lintLaunch — non-standard resource properties (D-46)", () => {
	it("warns on a typo'd property with the type's known property list", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    requires:
      - type: postgres
        set_env:
          DB_HOST: $hoost
`);
		const warnings = lintLaunch(launch);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toBe(
			'"$hoost" is not in the standard vocabulary for postgres ' +
				"(known: url, host, port, user, password, name)",
		);
	});

	it("stays silent for known properties, templates, and fallbacks", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    requires:
      - type: postgres
        set_env:
          DATABASE_URL: $url
          DB_ADDR: "\${host}:\${port:-5432}"
      - type: redis
        set_env:
          REDIS_PASSWORD: $password
`);
		expect(lintLaunch(launch)).toEqual([]);
	});

	it("stays silent for unknown resource types (L-4: types stay open)", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    requires:
      - type: mariadb
        set_env:
          DB_SOCKET: $socket
`);
		expect(lintLaunch(launch)).toEqual([]);
	});

	it("stays silent for reserved namespaces and cross-resource references", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    requires:
      - type: postgres
        set_env:
          PUBLIC_URL: $app.url
          API_KEY: $secrets.api-key
          CACHE_URL: $redis.url
`);
		expect(lintLaunch(launch)).toEqual([]);
	});

	it("warns per occurrence across multiple components", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    requires:
      - type: postgres
        set_env:
          DB_HOST: $hoost
  worker:
    image: worker:latest
    requires:
      - type: redis
        set_env:
          REDIS_URL: $uri
`);
		const warnings = lintLaunch(launch);
		expect(warnings).toHaveLength(2);
		expect(warnings.join("\n")).toContain(
			'"$hoost" is not in the standard vocabulary for postgres',
		);
		expect(warnings.join("\n")).toContain(
			'"$uri" is not in the standard vocabulary for redis ' +
				"(known: url, host, port, password)",
		);
	});

	it("warns inside template expressions on a supports entry", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    supports:
      - type: redis
        set_env:
          CACHE_ADDR: "\${hostt}:\${port}"
`);
		const warnings = lintLaunch(launch);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"$hostt"');
	});
});
