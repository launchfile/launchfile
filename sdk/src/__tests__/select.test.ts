import { describe, expect, it } from "vitest";
import { readLaunch } from "../reader.js";
import { selectComponents } from "../select.js";

const MULTI = `
name: acme
components:
  backend:
    runtime: node
    requires:
      - type: postgres
        set_env: { DATABASE_URL: $url }
      - type: redis
        set_env: { REDIS_URL: $url }
    commands: { start: "node dist/main.js" }
  frontend:
    runtime: node
    depends_on:
      - component: backend
        condition: healthy
    commands: { start: "node server.js" }
`;

describe("selectComponents", () => {
	const launch = readLaunch(MULTI);

	it("selects a single existing component", () => {
		const r = selectComponents(launch, ["backend"]);
		expect(r.selected).toEqual(["backend"]);
		expect(r.resources).toEqual([]);
		expect(r.unknown).toEqual([]);
	});

	it("empty selector means all components", () => {
		const r = selectComponents(launch, []);
		expect(r.selected.sort()).toEqual(["backend", "frontend"]);
	});

	it("does NOT expand depends_on targets (satisfy-not-expand)", () => {
		const r = selectComponents(launch, ["frontend"]);
		expect(r.selected).toEqual(["frontend"]);
		expect(r.selected).not.toContain("backend");
	});

	it("classifies a resource type as a resource, not a component", () => {
		const r = selectComponents(launch, ["postgres", "redis", "backend"]);
		expect(r.selected).toEqual(["backend"]);
		expect(r.resources.sort()).toEqual(["postgres", "redis"]);
		expect(r.unknown).toEqual([]);
	});

	it("reports unknown names", () => {
		const r = selectComponents(launch, ["database"]);
		expect(r.selected).toEqual([]);
		expect(r.unknown).toEqual(["database"]);
	});
});
