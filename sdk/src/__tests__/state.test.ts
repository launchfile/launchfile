import { describe, expect, it } from "vitest";
import {
	type DeploymentState,
	diff,
	type Endpoint,
	type LaunchEvent,
	reduce,
	resolveRef,
	type Vantage,
} from "../state.js";

function emptyState(): DeploymentState {
	return {
		id: "acme-abc123",
		app: "acme",
		updatedAt: "2026-01-01T00:00:00.000Z",
		components: {},
		resources: {},
	};
}

const httpEndpoint: Endpoint = {
	name: "default",
	scheme: "http",
	internal: "acme-backend:3000",
	published: "localhost:54000",
};

describe("reduce", () => {
	it("does not mutate the input state", () => {
		const state = emptyState();
		const snapshot = JSON.parse(JSON.stringify(state));
		reduce(state, {
			kind: "component.status",
			component: "backend",
			status: "up",
		});
		expect(state).toEqual(snapshot);
	});

	it("carries updatedAt over by default and accepts an explicit stamp", () => {
		const state = emptyState();
		const carried = reduce(state, {
			kind: "component.status",
			component: "backend",
			status: "up",
		});
		expect(carried.updatedAt).toBe(state.updatedAt);

		const stamped = reduce(
			state,
			{ kind: "component.status", component: "backend", status: "up" },
			"2026-02-02T00:00:00.000Z",
		);
		expect(stamped.updatedAt).toBe("2026-02-02T00:00:00.000Z");
	});

	it("records a slot event as a status on the component", () => {
		const next = reduce(emptyState(), {
			slot: "run",
			phase: "completed",
			component: "backend",
		});
		expect(next.components.backend?.status).toBe("up");

		const failed = reduce(emptyState(), {
			slot: "prepare",
			phase: "failed",
			component: "backend",
		});
		expect(failed.components.backend?.status).toBe("prepare:failed");
	});

	it("upserts an endpoint and keeps endpoints sorted by name", () => {
		let state = emptyState();
		state = reduce(state, {
			kind: "endpoint.resolved",
			component: "backend",
			endpoint: {
				name: "metrics",
				scheme: "http",
				internal: "acme-backend:9090",
			},
		});
		state = reduce(state, {
			kind: "endpoint.resolved",
			component: "backend",
			endpoint: httpEndpoint,
		});
		expect(state.components.backend?.endpoints.map((e) => e.name)).toEqual([
			"default",
			"metrics",
		]);

		// Re-resolving the same name replaces, not duplicates.
		state = reduce(state, {
			kind: "endpoint.resolved",
			component: "backend",
			endpoint: { ...httpEndpoint, published: "localhost:55555" },
		});
		const def = state.components.backend?.endpoints.find(
			(e) => e.name === "default",
		);
		expect(state.components.backend?.endpoints).toHaveLength(2);
		expect(def?.published).toBe("localhost:55555");
	});

	it("records component.status", () => {
		const next = reduce(emptyState(), {
			kind: "component.status",
			component: "backend",
			status: "unhealthy",
		});
		expect(next.components.backend?.status).toBe("unhealthy");
	});

	it("records a capture", () => {
		const next = reduce(emptyState(), {
			kind: "capture",
			component: "backend",
			name: "admin-url",
			value: "http://localhost:54000/admin",
		});
		expect(next.components.backend?.captures["admin-url"]).toBe(
			"http://localhost:54000/admin",
		);
	});

	it("records a provisioned resource with sorted endpoints", () => {
		const next = reduce(emptyState(), {
			kind: "resource.provisioned",
			name: "primary-db",
			type: "postgres",
			endpoints: [
				{ name: "replica", scheme: "postgres", internal: "db-r:5432" },
				{ name: "default", scheme: "postgres", internal: "db:5432" },
			],
		});
		expect(next.resources["primary-db"]?.type).toBe("postgres");
		expect(next.resources["primary-db"]?.endpoints.map((e) => e.name)).toEqual([
			"default",
			"replica",
		]);
	});
});

describe("diff", () => {
	function fold(
		state: DeploymentState,
		events: LaunchEvent[],
	): DeploymentState {
		return events.reduce((acc, e) => reduce(acc, e), state);
	}

	/** Compare only the fields diff/reduce cover. */
	function covered(state: DeploymentState) {
		const components: Record<string, unknown> = {};
		for (const [name, c] of Object.entries(state.components)) {
			components[name] = {
				status: c.status,
				endpoints: c.endpoints,
				captures: c.captures,
			};
		}
		const resources: Record<string, unknown> = {};
		for (const [name, r] of Object.entries(state.resources)) {
			resources[name] = { type: r.type, endpoints: r.endpoints };
		}
		return { components, resources };
	}

	it("returns no events for identical states", () => {
		const a = emptyState();
		expect(diff(a, a)).toEqual([]);
	});

	it("round-trips: fold(diff(a,b)) over a equals b for covered fields", () => {
		const a = emptyState();
		let b = emptyState();
		b = reduce(b, {
			kind: "component.status",
			component: "backend",
			status: "up",
		});
		b = reduce(b, {
			kind: "endpoint.resolved",
			component: "backend",
			endpoint: httpEndpoint,
		});
		b = reduce(b, {
			kind: "capture",
			component: "backend",
			name: "token",
			value: "abc",
		});
		b = reduce(b, {
			kind: "resource.provisioned",
			name: "redis",
			type: "redis",
			endpoints: [{ name: "default", scheme: "redis", internal: "redis:6379" }],
		});

		const events = diff(a, b);
		expect(covered(fold(a, events))).toEqual(covered(b));
	});

	it("round-trips when fields change between two non-empty states", () => {
		let a = emptyState();
		a = reduce(a, {
			kind: "component.status",
			component: "backend",
			status: "up",
		});
		a = reduce(a, {
			kind: "endpoint.resolved",
			component: "backend",
			endpoint: httpEndpoint,
		});

		let b = a;
		b = reduce(b, {
			kind: "component.status",
			component: "backend",
			status: "unhealthy",
		});
		b = reduce(b, {
			kind: "endpoint.resolved",
			component: "backend",
			endpoint: { ...httpEndpoint, published: "localhost:60000" },
		});

		const events = diff(a, b);
		expect(events.length).toBeGreaterThan(0);
		expect(covered(fold(a, events))).toEqual(covered(b));
	});

	it("produces a deterministic, stably-ordered event list", () => {
		const a = emptyState();
		let b = emptyState();
		b = reduce(b, {
			kind: "component.status",
			component: "zeta",
			status: "up",
		});
		b = reduce(b, {
			kind: "component.status",
			component: "alpha",
			status: "up",
		});

		const components = diff(a, b)
			.filter((e) => "kind" in e && e.kind === "component.status")
			.map((e) => (e as { component: string }).component);
		expect(components).toEqual(["alpha", "zeta"]);
	});
});

describe("resolveRef", () => {
	function stateWithBackend(): DeploymentState {
		let state = emptyState();
		state = reduce(state, {
			kind: "endpoint.resolved",
			component: "backend",
			endpoint: httpEndpoint,
		});
		state = reduce(state, {
			kind: "capture",
			component: "backend",
			name: "admin-token",
			value: "s3cret",
		});
		state = reduce(state, {
			kind: "resource.provisioned",
			name: "primary-db",
			type: "postgres",
			endpoints: [
				{
					name: "default",
					scheme: "postgres",
					internal: "primary-db:5432",
					published: "localhost:55432",
				},
			],
		});
		return state;
	}

	const hostVantage: Vantage = {
		provider: "docker",
		mode: "source",
		network: "host",
	};
	const networkVantage: Vantage = {
		provider: "docker",
		mode: "artifact",
		network: "compose",
	};

	it("host vantage gets the published address", () => {
		const state = stateWithBackend();
		expect(resolveRef(state, "$components.backend.url", hostVantage)).toBe(
			"http://localhost:54000",
		);
		expect(resolveRef(state, "$components.backend.host", hostVantage)).toBe(
			"localhost",
		);
		expect(resolveRef(state, "$components.backend.port", hostVantage)).toBe(
			"54000",
		);
	});

	it("in-network vantage gets the internal address", () => {
		const state = stateWithBackend();
		expect(resolveRef(state, "$components.backend.url", networkVantage)).toBe(
			"http://acme-backend:3000",
		);
		expect(resolveRef(state, "$components.backend.host", networkVantage)).toBe(
			"acme-backend",
		);
		expect(resolveRef(state, "$components.backend.port", networkVantage)).toBe(
			"3000",
		);
	});

	it("source mode without an explicit network still prefers published", () => {
		const state = stateWithBackend();
		const v: Vantage = { provider: "docker", mode: "source" };
		expect(resolveRef(state, "$components.backend.url", v)).toBe(
			"http://localhost:54000",
		);
	});

	it("falls back to internal when no published address exists", () => {
		let state = emptyState();
		state = reduce(state, {
			kind: "endpoint.resolved",
			component: "worker",
			endpoint: {
				name: "default",
				scheme: "http",
				internal: "acme-worker:8080",
			},
		});
		expect(resolveRef(state, "$components.worker.url", hostVantage)).toBe(
			"http://acme-worker:8080",
		);
	});

	it("resolves a resource reference and honors vantage", () => {
		const state = stateWithBackend();
		expect(resolveRef(state, "$primary-db.host", hostVantage)).toBe(
			"localhost",
		);
		expect(resolveRef(state, "$primary-db.host", networkVantage)).toBe(
			"primary-db",
		);
		expect(resolveRef(state, "$primary-db.port", networkVantage)).toBe("5432");
	});

	it("resolves a capture by name", () => {
		const state = stateWithBackend();
		expect(
			resolveRef(state, "$components.backend.admin-token", hostVantage),
		).toBe("s3cret");
	});

	it("returns empty string for unknown references", () => {
		const state = stateWithBackend();
		expect(resolveRef(state, "$components.nope.url", hostVantage)).toBe("");
		expect(resolveRef(state, "$components.backend.bogus", hostVantage)).toBe(
			"",
		);
		expect(resolveRef(state, "$missing-db.host", hostVantage)).toBe("");
		expect(resolveRef(state, "literal", hostVantage)).toBe("");
		expect(resolveRef(state, "$components.backend", hostVantage)).toBe("");
	});
});
