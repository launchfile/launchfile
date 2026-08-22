import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { refusedHostCapabilities } from "../provider.js";

/**
 * This provider grants no host capabilities (D-44, PROVIDERS.md §11), so a
 * required one must DECLINE the component. Logging a refusal while still
 * starting the component is the failure these tests exist to catch — the
 * message alone reads correct, so only an outcome assertion pins it.
 */
describe("refusedHostCapabilities (D-44 grant/refuse)", () => {
	const mk = (body: string) => readLaunch(`version: launch/v1\nname: app\n${body}`);

	it("refuses a component declaring a capability via the host: entry form", () => {
		const refused = mk(
			"commands:\n  start: run\nrequires:\n  - host: { container_runtime: docker }\n",
		);
		expect([...refusedHostCapabilities(refused).keys()]).toEqual(["default"]);
	});

	it("refuses the legacy block identically (§11 equivalence)", () => {
		const entry = refusedHostCapabilities(
			mk("commands:\n  start: run\nrequires:\n  - host: { container_runtime: docker }\n"),
		);
		const legacy = refusedHostCapabilities(
			mk("commands:\n  start: run\nhost:\n  docker: required\n"),
		);
		expect([...legacy.keys()]).toEqual([...entry.keys()]);
	});

	it("names the capability it cannot grant", () => {
		const refused = refusedHostCapabilities(
			mk("commands:\n  start: run\nrequires:\n  - host: { container_runtime: docker }\n"),
		);
		expect(refused.get("default")?.join()).toContain("container_runtime=docker");
	});

	it("refuses the legacy network and privileged keys too", () => {
		expect(
			refusedHostCapabilities(mk("commands:\n  start: run\nhost:\n  network: host\n")).size,
		).toBe(1);
		expect(
			refusedHostCapabilities(mk("commands:\n  start: run\nhost:\n  privileged: true\n")).size,
		).toBe(1);
	});

	it("does not refuse an optional capability — it runs degraded", () => {
		const launch = mk(
			"commands:\n  start: run\nsupports:\n  - host: { container_runtime: any }\n",
		);
		expect(refusedHostCapabilities(launch).size).toBe(0);
	});

	it("does not refuse a component with a plain backing service", () => {
		expect(
			refusedHostCapabilities(mk("commands:\n  start: run\nrequires:\n  - postgres\n")).size,
		).toBe(0);
	});

	it("refuses only the declaring component, leaving siblings runnable", () => {
		const launch = mk(
			"components:\n" +
				"  needsdocker:\n    commands:\n      start: run\n    requires:\n      - host: { container_runtime: docker }\n" +
				"  plain:\n    commands:\n      start: run\n",
		);
		expect([...refusedHostCapabilities(launch).keys()]).toEqual(["needsdocker"]);
	});
});
