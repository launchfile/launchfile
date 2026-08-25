import { describe, expect, it } from "vitest";
import { healthFailureMessage, isContainerHealthy } from "../provider.js";

describe("isContainerHealthy", () => {
	it("accepts a running container that declares no health check", () => {
		expect(isContainerHealthy({ State: "running", Health: "" })).toBe(true);
	});

	it("accepts a running container that passes its check", () => {
		expect(isContainerHealthy({ State: "running", Health: "healthy" })).toBe(true);
	});

	it("rejects a container that is not running, whatever its health says", () => {
		expect(isContainerHealthy({ State: "exited", Health: "" })).toBe(false);
		expect(isContainerHealthy({ State: "exited", Health: "healthy" })).toBe(false);
	});

	it("rejects a running container that is starting or failing its check", () => {
		expect(isContainerHealthy({ State: "running", Health: "starting" })).toBe(false);
		expect(isContainerHealthy({ State: "running", Health: "unhealthy" })).toBe(false);
	});
});

describe("healthFailureMessage", () => {
	it("names the services that never became healthy", () => {
		expect(healthFailureMessage(["web"], 120)).toBe(
			"component(s) web did not become healthy within 120s",
		);
	});

	it("names every stuck service when only some of them are stuck", () => {
		// The common case: most of the project is up and one service is wedged.
		// Saying "no component became healthy" here would be false.
		expect(healthFailureMessage(["api", "worker"], 120)).toBe(
			"component(s) api, worker did not become healthy within 120s",
		);
	});

	it("says nothing was running when no container ever reported", () => {
		expect(healthFailureMessage([], 120)).toBe("no container was running after 120s");
	});
});
