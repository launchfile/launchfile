import { readLaunch, resolveSourceRunCommand } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { applyHostCapabilityRefusals, refusedHostCapabilities } from "../provider.js";

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

/**
 * The classifier tests above say *which* components are refused. These say what
 * the provider then does with that answer — the part that actually keeps a
 * refused component off the host.
 *
 * Gutting the removal in applyHostCapabilityRefusals leaves every test above
 * passing, because a refusal that is only printed still reads correct. These
 * fail.
 */
describe("applyHostCapabilityRefusals — the refusal is the removal", () => {
	const mk = (body: string) => readLaunch(`version: launch/v1\nname: app\n${body}`);

	/** The names launchUp would hand to the process manager. */
	const wouldStart = (launch: ReturnType<typeof readLaunch>) =>
		Object.entries(launch.components)
			.filter(([, c]) => resolveSourceRunCommand(c) !== undefined)
			.map(([n]) => n);

	const twoComponents = () =>
		mk(
			"components:\n" +
				"  needsdocker:\n    commands:\n      start: run-it\n    requires:\n      - host: { container_runtime: docker }\n" +
				"  sibling:\n    commands:\n      start: run-it\n",
		);

	it("does not hand a refused component to the process manager", () => {
		const launch = twoComponents();
		expect(wouldStart(launch)).toContain("needsdocker");
		applyHostCapabilityRefusals(launch);
		expect(wouldStart(launch)).not.toContain("needsdocker");
	});

	it("still starts the siblings", () => {
		const launch = twoComponents();
		applyHostCapabilityRefusals(launch);
		expect(wouldStart(launch)).toEqual(["sibling"]);
	});

	it("removes the component from the map, not just from the output", () => {
		const launch = twoComponents();
		applyHostCapabilityRefusals(launch);
		expect(Object.keys(launch.components)).toEqual(["sibling"]);
	});

	it("reports none-left when every component is refused", () => {
		const launch = mk(
			"commands:\n  start: run-it\nrequires:\n  - host: { container_runtime: docker }\n",
		);
		expect(applyHostCapabilityRefusals(launch)).toBe("none-left");
	});

	it("refuses the legacy block the same way", () => {
		const launch = mk("commands:\n  start: run-it\nhost:\n  docker: required\n");
		expect(applyHostCapabilityRefusals(launch)).toBe("none-left");
	});

	it("leaves an app with no host capabilities untouched", () => {
		const launch = mk("commands:\n  start: run-it\nrequires:\n  - postgres\n");
		expect(applyHostCapabilityRefusals(launch)).toBe("ok");
		expect(wouldStart(launch)).toEqual(["default"]);
	});

	it("does not refuse a component for an optional capability", () => {
		const launch = mk(
			"commands:\n  start: run-it\nsupports:\n  - host: { container_runtime: any }\n",
		);
		expect(applyHostCapabilityRefusals(launch)).toBe("ok");
		expect(wouldStart(launch)).toEqual(["default"]);
	});
});
