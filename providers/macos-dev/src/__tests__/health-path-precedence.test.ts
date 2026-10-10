/**
 * SPEC.md § health: when a block declares both `path` and `command`, `path`
 * takes precedence. Every macos-dev helper that picks a probe must agree.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeHealthCheck, healthCheckNeedsPort, waitForHealthy } from "../health.js";

const BOTH = { path: "/healthz", command: "exit 1" };
const EMPTY_PATH_AND_COMMAND = { path: "", command: "exit 1" };

describe("healthCheckNeedsPort", () => {
	it("needs a port when path and command are both declared", () => {
		expect(healthCheckNeedsPort(BOTH)).toBe(true);
	});

	it("needs a port when an empty path is declared beside a command", () => {
		expect(healthCheckNeedsPort(EMPTY_PATH_AND_COMMAND)).toBe(true);
	});

	it("needs no port for a command-only check", () => {
		expect(healthCheckNeedsPort({ command: "true" })).toBe(false);
	});

	it("needs a port for a path-only check and for no check", () => {
		expect(healthCheckNeedsPort({ path: "/h" })).toBe(true);
		expect(healthCheckNeedsPort({})).toBe(true);
	});
});

describe("describeHealthCheck", () => {
	it("describes the GET probe when path and command are both declared", () => {
		expect(describeHealthCheck(BOTH, 8080)).toBe("GET http://localhost:8080/healthz");
	});

	it("marks the port unallocated for a path+command block with no port", () => {
		expect(describeHealthCheck(BOTH, undefined)).toBe("GET http://localhost:<unallocated>/healthz");
	});

	it("describes the GET probe for an empty path beside a command", () => {
		expect(describeHealthCheck(EMPTY_PATH_AND_COMMAND, 8080)).toBe("GET http://localhost:8080");
	});

	it("describes the command for a command-only check", () => {
		expect(describeHealthCheck({ command: "true" }, undefined)).toBe("command `true`");
	});
});

describe("waitForHealthy path precedence", () => {
	let server: Server | undefined;

	async function serve(status: number): Promise<number> {
		server = createServer((req, res) => {
			res.statusCode = req.url === "/healthz" || req.url === "/" ? status : 404;
			res.end();
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		return (server.address() as AddressInfo).port;
	}

	afterEach(async () => {
		vi.restoreAllMocks();
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = undefined;
	});

	it("probes the path, not the failing command, when both are declared", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const port = await serve(200);
		const ok = await waitForHealthy("web", { ...BOTH, interval: "50ms", timeout: "1s" }, port, 1_000);
		expect(ok).toBe(true);
	});

	it("probes the root for an empty path beside a failing command", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const port = await serve(200);
		const ok = await waitForHealthy(
			"web",
			{ ...EMPTY_PATH_AND_COMMAND, interval: "50ms", timeout: "1s" },
			port,
			1_000,
		);
		expect(ok).toBe(true);
	});

	it("fails when the path probe fails even though the command would pass", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const port = await serve(500);
		const ok = await waitForHealthy(
			"web",
			{ path: "/healthz", command: "true", interval: "50ms", timeout: "1s" },
			port,
			400,
		);
		expect(ok).toBe(false);
	});
});
