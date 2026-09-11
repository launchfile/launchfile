import { describe, expect, it, vi } from "vitest";

/** Every argv the provider hands to `shell`, newest last. */
const shellCalls: string[][] = [];

vi.mock("../shell.js", () => ({
	shell: async (cmd: string, args: string[]) => {
		shellCalls.push([cmd, ...args]);
		return {
			exitCode: 0,
			stdout: JSON.stringify({
				State: "running",
				Health: "healthy",
				Name: "proj-api-1",
				Service: "api",
			}),
			stderr: "",
		};
	},
	shellStream: async () => 0,
	shellOk: async () => true,
}));

import {
	healthFailureMessage,
	healthPsArgs,
	isContainerHealthy,
	waitForHealth,
} from "../provider.js";

/**
 * `Health: ""` from `docker compose ps` is ambiguous: it means "no check
 * declared" for one service and "check declared, not yet evaluated" for
 * another. `healthchecks` — the generator's record of which services it wrote a
 * `healthcheck:` block for — is what tells the two apart.
 */
describe("isContainerHealthy", () => {
	it("accepts a running container whose service declares no health check", () => {
		expect(
			isContainerHealthy({ State: "running", Health: "", Service: "web" }, { web: false }),
		).toBe(true);
	});

	it("accepts a running container that passes its declared check", () => {
		expect(
			isContainerHealthy({ State: "running", Health: "healthy", Service: "web" }, { web: true }),
		).toBe(true);
	});

	it("rejects a declared check that has not been evaluated yet", () => {
		// The #325 crash-loop window: a restarting container reports running with
		// an empty Health. Treating that as "declares no check" passed the gate.
		expect(
			isContainerHealthy({ State: "running", Health: "", Service: "web" }, { web: true }),
		).toBe(false);
	});

	it("rejects a container that is not running, whatever its health says", () => {
		expect(
			isContainerHealthy({ State: "exited", Health: "", Service: "web" }, { web: false }),
		).toBe(false);
		expect(
			isContainerHealthy({ State: "exited", Health: "healthy", Service: "web" }, { web: true }),
		).toBe(false);
		expect(
			isContainerHealthy({ State: "restarting", Health: "", Service: "web" }, { web: true }),
		).toBe(false);
	});

	it("rejects a running container that is starting or failing its check", () => {
		expect(
			isContainerHealthy({ State: "running", Health: "starting", Service: "web" }, { web: true }),
		).toBe(false);
		expect(
			isContainerHealthy({ State: "running", Health: "unhealthy", Service: "web" }, { web: true }),
		).toBe(false);
	});

	it("keys on the compose service name, not the container name", () => {
		// Pins the keying on both sides: `healthchecks` comes from the generator's
		// service keys, and `Service` is the same string `ps` returns. A rename on
		// either side empties the match and this test fails instead of the gate
		// silently passing.
		expect(
			isContainerHealthy(
				{ State: "running", Health: "", Service: "web", Name: "myapp-web-1" },
				{ web: false },
			),
		).toBe(true);
		expect(
			isContainerHealthy(
				{ State: "running", Health: "", Service: "web", Name: "myapp-web-1" },
				{ "myapp-web-1": false },
			),
		).toBe(false);
	});

	it("rejects a container it cannot match to a generated service", () => {
		// The provider wrote both sides. An unmatched name is a gap to report,
		// never one to absorb into a pass.
		expect(
			isContainerHealthy({ State: "running", Health: "", Service: "stranger" }, { web: false }),
		).toBe(false);
		expect(
			isContainerHealthy({ State: "running", Health: "healthy", Service: "stranger" }, { web: true }),
		).toBe(false);
		expect(isContainerHealthy({ State: "running", Health: "" }, { web: false })).toBe(false);
	});

	it("does not match a service named after an Object.prototype key", () => {
		// `healthchecks` is a lookup of generated service names, not a prototype
		// chain. A container calling itself `toString` matches no generated
		// service, so it is a stranger like any other.
		expect(
			isContainerHealthy({ State: "running", Health: "healthy", Service: "toString" }, { web: true }),
		).toBe(false);
		expect(
			isContainerHealthy({ State: "running", Health: "", Service: "constructor" }, { web: false }),
		).toBe(false);
	});
});

describe("healthPsArgs", () => {
	it("scopes the poll to the generated services", () => {
		expect(healthPsArgs("proj", "/tmp/compose.yaml", { web: true, db: false })).toEqual([
			"compose", "-p", "proj", "-f", "/tmp/compose.yaml", "ps", "--format", "json", "web", "db",
		]);
	});

	it("leaves behind the orphan a rename strands", () => {
		// `up -d` runs without `--remove-orphans`, so the container of a service
		// renamed `web` -> `api` keeps running and an unscoped `ps` still reports
		// `Service: "web"`. Unmatched rows fail closed, so an unscoped poll would
		// spend the whole budget and then name a component the app no longer has.
		const args = healthPsArgs("proj", "/tmp/compose.yaml", { api: true });

		expect(args).toContain("api");
		expect(args).not.toContain("web");
	});

	it("names the services after the format flag, where docker takes them", () => {
		const args = healthPsArgs("proj", "/tmp/compose.yaml", { web: true });

		expect(args.slice(-3)).toEqual(["--format", "json", "web"]);
	});

	it("polls bare when the generator emitted no services", () => {
		// Nothing was generated, so there is nothing the gate can accept: every
		// row the bare poll returns fails closed anyway.
		expect(healthPsArgs("proj", "/tmp/compose.yaml", {})).toEqual([
			"compose", "-p", "proj", "-f", "/tmp/compose.yaml", "ps", "--format", "json",
		]);
	});
});

/** `docker compose ps --format json` output for the given rows. */
function psLines(...rows: Record<string, string>[]): string {
	return rows.map((r) => JSON.stringify(r)).join("\n");
}

describe("waitForHealth", () => {
	const fast = { maxWaitMs: 30, pollIntervalMs: 1 };

	it("fails a healthchecked service stuck at running with an empty Health", async () => {
		const outcome = await waitForHealth("proj", "/tmp/compose.yaml", { web: true }, {
			...fast,
			ps: async () => ({
				exitCode: 0,
				stdout: psLines({ State: "running", Health: "", Service: "web", Name: "proj-web-1" }),
			}),
		});

		expect(outcome).toEqual({ ok: false, stuck: ["web"] });
	});

	it("passes a healthchecked service once its check reports healthy", async () => {
		const outcome = await waitForHealth("proj", "/tmp/compose.yaml", { web: true }, {
			...fast,
			ps: async () => ({
				exitCode: 0,
				stdout: psLines({ State: "running", Health: "healthy", Service: "web" }),
			}),
		});

		expect(outcome).toEqual({ ok: true, stuck: [] });
	});

	it("passes a running service that declares no check", async () => {
		const outcome = await waitForHealth("proj", "/tmp/compose.yaml", { web: false }, {
			...fast,
			ps: async () => ({
				exitCode: 0,
				stdout: psLines({ State: "running", Health: "", Service: "web" }),
			}),
		});

		expect(outcome).toEqual({ ok: true, stuck: [] });
	});

	it("names only the stuck service when a sibling is already healthy", async () => {
		const outcome = await waitForHealth("proj", "/tmp/compose.yaml", { web: true, db: true }, {
			...fast,
			ps: async () => ({
				exitCode: 0,
				stdout: psLines(
					{ State: "running", Health: "healthy", Service: "db" },
					{ State: "running", Health: "", Service: "web" },
				),
			}),
		});

		expect(outcome).toEqual({ ok: false, stuck: ["web"] });
	});

	it("reports nothing running when no container ever appears", async () => {
		const outcome = await waitForHealth("proj", "/tmp/compose.yaml", { web: true }, {
			...fast,
			ps: async () => ({ exitCode: 0, stdout: "" }),
		});

		expect(outcome).toEqual({ ok: false, stuck: [] });
	});

	it("polls the generated services when no ps is injected", async () => {
		shellCalls.length = 0;

		const outcome = await waitForHealth("proj", "/tmp/compose.yaml", { api: true }, fast);

		expect(outcome).toEqual({ ok: true, stuck: [] });
		expect(shellCalls).toHaveLength(1);
		expect(shellCalls[0]).toEqual([
			"docker", "compose", "-p", "proj", "-f", "/tmp/compose.yaml", "ps", "--format", "json", "api",
		]);
	});

	it("keeps polling while ps itself fails", async () => {
		let calls = 0;
		const outcome = await waitForHealth("proj", "/tmp/compose.yaml", { web: true }, {
			...fast,
			ps: async () => {
				calls += 1;
				return calls === 1
					? { exitCode: 1, stdout: "" }
					: {
							exitCode: 0,
							stdout: psLines({ State: "running", Health: "healthy", Service: "web" }),
						};
			},
		});

		expect(outcome).toEqual({ ok: true, stuck: [] });
		expect(calls).toBeGreaterThan(1);
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
