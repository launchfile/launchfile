import { describe, expect, it } from "vitest";
import { readLaunch } from "../reader.js";
import { selectComponents, selectionClosure } from "../select.js";

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

// a -> b -> c chain plus an unrelated component, for closure tests.
const CHAIN = `
name: chain
components:
  a:
    runtime: node
    depends_on: [b]
    commands: { start: "node a.js" }
  b:
    runtime: node
    depends_on: [c]
    commands: { start: "node b.js" }
  c:
    runtime: node
    commands: { start: "node c.js" }
  unrelated:
    runtime: node
    commands: { start: "node u.js" }
`;

// p <-> q form a depends_on cycle; the closure must terminate.
const CYCLE = `
name: cyclic
components:
  p:
    runtime: node
    depends_on: [q]
    commands: { start: "node p.js" }
  q:
    runtime: node
    depends_on: [p]
    commands: { start: "node q.js" }
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

	it("classifies (does not expand) — selected is exactly the requested components", () => {
		// Closure expansion is selectionClosure's job (D-41); the classifier
		// returns the literal requested components, nothing more.
		const r = selectComponents(launch, ["frontend"]);
		expect(r.selected).toEqual(["frontend"]);
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

describe("selectionClosure (D-41)", () => {
	const launch = readLaunch(MULTI);

	it("starts a selected component plus its downward depends_on target", () => {
		const r = selectionClosure(launch, ["frontend"]);
		// frontend depends_on backend → backend joins the start-set.
		expect(r.start).toEqual(["backend", "frontend"]);
	});

	it("does NOT pull in reverse-dependencies (downward only)", () => {
		const r = selectionClosure(launch, ["backend"]);
		// frontend depends_on backend, but `up backend` must not start frontend.
		expect(r.start).toEqual(["backend"]);
		expect(r.start).not.toContain("frontend");
	});

	it("follows a transitive a→b→c chain and excludes unrelated components", () => {
		const r = selectionClosure(readLaunch(CHAIN), ["a"]);
		expect(r.start).toEqual(["a", "b", "c"]);
		expect(r.start).not.toContain("unrelated");
	});

	it("empty selection is the full closure (all components)", () => {
		const r = selectionClosure(readLaunch(CHAIN), []);
		expect(r.start).toEqual(["a", "b", "c", "unrelated"]);
	});

	it("terminates on a depends_on cycle instead of hanging", () => {
		const r = selectionClosure(readLaunch(CYCLE), ["p"]);
		expect(r.start).toEqual(["p", "q"]);
	});

	it("returns an empty start-set when the selection is invalid", () => {
		const r = selectionClosure(launch, ["postgres", "nope"]);
		expect(r.start).toEqual([]);
		expect(r.resources).toEqual(["postgres"]);
		expect(r.unknown).toEqual(["nope"]);
	});
});
