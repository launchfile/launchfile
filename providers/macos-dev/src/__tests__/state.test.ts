import { describe, it, expect } from "vitest";
import { initState, hashLaunchfile } from "../state.js";

describe("initState", () => {
	it("creates a state with correct app name", () => {
		const state = initState("my-app", "name: my-app");
		expect(state.appName).toBe("my-app");
		expect(state.version).toBe(1);
		expect(state.resources).toEqual({});
		expect(state.secrets).toEqual({});
		expect(state.ports).toEqual({});
	});

	it("hashes launchfile content", () => {
		const state = initState("app", "some yaml content");
		expect(state.launchfileHash).toBeTruthy();
		expect(state.launchfileHash.length).toBe(16);
	});
});

describe("hashLaunchfile", () => {
	it("is deterministic", () => {
		const a = hashLaunchfile("hello");
		const b = hashLaunchfile("hello");
		expect(a).toBe(b);
	});

	it("differs for different content", () => {
		const a = hashLaunchfile("hello");
		const b = hashLaunchfile("world");
		expect(a).not.toBe(b);
	});
});
