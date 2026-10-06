import { Writable } from "node:stream";
import { readLaunch } from "@launchfile/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { createLogger, REDACT_PATHS, serializeErr } from "../logger.js";
import { clearRegisteredSecrets, registerSecret } from "../redact.js";
import { translate } from "../translate.js";

/**
 * The provider's own logger, bound to a captured stream: every assertion runs
 * against the redaction config `getLogger()` ships, not a test-local copy.
 */
function capturedLogger() {
	const lines: string[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			lines.push(chunk.toString().trim());
			callback();
		},
	});
	const logger = createLogger(stream);
	return {
		logger,
		getLogs: (): Array<Record<string, unknown>> =>
			lines.map((line) => JSON.parse(line)),
		raw: (): string => lines.join("\n"),
	};
}

beforeEach(() => {
	clearRegisteredSecrets();
});

describe("err serializer", () => {
	it("redacts a registered secret in the message and the stack", () => {
		registerSecret("registered-secret-value");
		const serialized = serializeErr(
			new Error("refused: registered-secret-value"),
		);
		expect(serialized.message).toBe("refused: [REDACTED]");
		expect(serialized.stack).not.toContain("registered-secret-value");
		expect(serialized.stack).toContain("[REDACTED]");
	});

	it("redacts a registered secret on a property attached to the error", () => {
		registerSecret("registered-secret-value");
		const err = Object.assign(new Error("command failed"), {
			result: { stdout: "token=registered-secret-value", exitCode: 1 },
			display: "curl -H registered-secret-value",
		});
		const serialized = serializeErr(err);
		const result = serialized.result as Record<string, unknown>;
		expect(result.stdout).toBe("token=[REDACTED]");
		expect(serialized.display).toBe("curl -H [REDACTED]");
	});

	it("redacts a credential embedded in a URL that was never registered", () => {
		const serialized = serializeErr(
			new Error("failed https://user:ghp_abc123@registry.example.com/img"),
		);
		expect(serialized.message).toBe(
			"failed https://user:[REDACTED]@registry.example.com/img",
		);
		expect(serialized.stack).not.toContain("ghp_abc123");
	});

	it("keeps pino's standard error record shape", () => {
		const serialized = serializeErr(new Error("plain failure"));
		expect(serialized).toHaveProperty("type", "Error");
		expect(serialized).toHaveProperty("message", "plain failure");
		expect(serialized).toHaveProperty("stack");
	});

	it("leaves non-sensitive text untouched", () => {
		const serialized = serializeErr(new Error("terraform validate exited 1"));
		expect(serialized.message).toBe("terraform validate exited 1");
	});

	it("returns rather than throws on a self-referential attached property", () => {
		registerSecret("registered-secret-value");
		const response: Record<string, unknown> = {
			name: "res",
			detail: "denied for registered-secret-value",
		};
		response.self = response;
		const err = Object.assign(new Error("boom"), { response });

		const serialized = serializeErr(err);

		const attached = serialized.response as Record<string, unknown>;
		expect(attached.detail).toBe("denied for [REDACTED]");
		expect(attached.self).toBe("[Circular]");
	});

	it("returns Date, Map, Set and Buffer values unchanged", () => {
		const date = new Date("2026-01-01T00:00:00.000Z");
		const err = Object.assign(new Error("boom"), {
			date,
			map: new Map([["k", "v"]]),
			set: new Set(["v"]),
			buf: Buffer.from("abcd"),
		});

		const serialized = serializeErr(err);

		expect(serialized.date).toBe(date);
		expect(serialized.map).toBeInstanceOf(Map);
		expect(serialized.set).toBeInstanceOf(Set);
		expect(Buffer.isBuffer(serialized.buf)).toBe(true);
	});
});

describe("provider logger", () => {
	it("keeps the path-based redaction for named fields", () => {
		const { logger, getLogs } = capturedLogger();
		logger.info({ password: "hunter2", config: { token: "t0k3n" } }, "x");
		const entry = getLogs()[0] as Record<string, unknown>;
		expect(entry.password).toBe("[REDACTED]");
		expect((entry.config as Record<string, unknown>).token).toBe("[REDACTED]");
		expect(REDACT_PATHS).toContain("*.value");
	});

	it("masks a registered secret in a logged error's message and stack", () => {
		registerSecret("registered-secret-value");
		const { logger, getLogs, raw } = capturedLogger();

		logger.error({ err: new Error("boom: registered-secret-value") }, "failed");

		const entry = getLogs()[0] as Record<string, unknown>;
		const loggedErr = entry.err as Record<string, unknown>;
		expect(loggedErr.message).toBe("boom: [REDACTED]");
		expect(raw()).not.toContain("registered-secret-value");
	});

	it("masks a registered secret on a property attached to the logged error", () => {
		registerSecret("registered-secret-value");
		const { logger, getLogs, raw } = capturedLogger();
		const err = Object.assign(new Error("failed"), {
			display: "psql registered-secret-value",
		});

		logger.error({ err }, "failed");

		const entry = getLogs()[0] as Record<string, unknown>;
		expect((entry.err as Record<string, unknown>).display).toBe(
			"psql [REDACTED]",
		);
		expect(raw()).not.toContain("registered-secret-value");
	});

	it("writes a line rather than throwing on a self-referential error", () => {
		registerSecret("registered-secret-value");
		const { logger, getLogs } = capturedLogger();
		const detail: Record<string, unknown> = {
			note: "denied for registered-secret-value",
		};
		detail.self = detail;
		const err = Object.assign(new Error("boom"), { detail });

		expect(() => logger.error({ err }, "failed")).not.toThrow();

		const entry = getLogs()[0] as Record<string, unknown>;
		const logged = (entry.err as Record<string, unknown>).detail as Record<
			string,
			unknown
		>;
		expect(logged.note).toBe("denied for [REDACTED]");
		expect(logged.self).toBe("[Circular]");
	});

	it("never prints the userinfo of a URL attached to the error", () => {
		const { logger, getLogs, raw } = capturedLogger();
		const err = Object.assign(new Error("clone failed"), {
			url: new URL("https://deploy:hunter2pass@git.example.com/repo.git"),
		});

		logger.error({ err }, "clone failed");

		const entry = getLogs()[0] as Record<string, unknown>;
		expect(raw()).not.toContain("hunter2pass");
		expect((entry.err as Record<string, unknown>).url).toEqual({});
	});

	it("masks a Launchfile's sensitive env literal after translate resolves it", () => {
		translate(
			readLaunch(`
version: launch/v1
name: app
runtime: node
env:
  API_KEY:
    default: literal-api-key-0123456789
    sensitive: true
  PIN:
    default: "824193"
    sensitive: true
  SITE_URL:
    default: https://example.com
commands:
  start: "node server.js"
`),
		);
		const { logger, getLogs, raw } = capturedLogger();

		logger.error(
			{
				err: new Error(
					"ssm put failed for literal-api-key-0123456789 / 824193",
				),
			},
			"failed https://example.com",
		);

		const entry = getLogs()[0] as Record<string, unknown>;
		expect((entry.err as Record<string, unknown>).message).toBe(
			"ssm put failed for [REDACTED] / [REDACTED]",
		);
		expect(entry.msg).toBe("failed https://example.com");
		expect(raw()).not.toContain("literal-api-key-0123456789");
		expect(raw()).not.toContain("824193");
	});
});
