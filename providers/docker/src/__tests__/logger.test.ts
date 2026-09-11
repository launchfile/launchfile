import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Writable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { REDACT_CONFIG, serializeErr } from "../logger.js";
import { clearRegisteredSecrets, registerSecret } from "../redact.js";

/**
 * Build an in-memory pino logger for testing JSON output and redaction.
 * We test the logger module's spans separately against the real module
 * (its singleton AsyncLocalStorage cannot be easily shimmed).
 */
function createTestLogger(opts?: pino.LoggerOptions) {
	const lines: string[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			lines.push(chunk.toString().trim());
			callback();
		},
	});

	const logger = pino(
		{
			level: "trace",
			timestamp: pino.stdTimeFunctions.isoTime,
			base: { service: "launchfile-docker" },
			...opts,
		},
		stream,
	);

	return {
		logger,
		getLogs: (): Array<Record<string, unknown>> =>
			lines.map((line) => JSON.parse(line)),
	};
}

describe("logger JSON output", () => {
	it("includes required fields: level, time, service, msg", () => {
		const { logger, getLogs } = createTestLogger();
		logger.info("hello");
		const [entry] = getLogs();
		expect(entry).toBeDefined();
		expect(entry).toHaveProperty("level", 30);
		expect(entry).toHaveProperty("time");
		expect(entry).toHaveProperty("service", "launchfile-docker");
		expect(entry).toHaveProperty("msg", "hello");
	});

	it("includes structured data alongside message", () => {
		const { logger, getLogs } = createTestLogger();
		logger.info({ slug: "ghost", project: "lf-ghost" }, "starting up");
		const [entry] = getLogs();
		expect(entry).toHaveProperty("slug", "ghost");
		expect(entry).toHaveProperty("project", "lf-ghost");
		expect(entry).toHaveProperty("msg", "starting up");
	});

	it("respects minimum log level", () => {
		const { logger, getLogs } = createTestLogger({ level: "warn" });
		logger.debug("should drop");
		logger.info("should drop");
		logger.warn("should keep");
		logger.error("should keep");
		const logs = getLogs();
		expect(logs).toHaveLength(2);
		expect(logs[0]).toHaveProperty("msg", "should keep");
		expect(logs[1]).toHaveProperty("msg", "should keep");
	});
});

describe("logger redaction", () => {
	// Use the real production redact config so regressions can't slip by with
	// a local test-only config. If this drifts from logger.ts, tests break.
	const redactOptions = {
		redact: { paths: [...REDACT_CONFIG.paths], censor: REDACT_CONFIG.censor },
	};

	it("redacts password at the top level", () => {
		const { logger, getLogs } = createTestLogger(redactOptions);
		logger.info({ password: "hunter2" }, "auth attempt");
		const [entry] = getLogs();
		expect(entry).toHaveProperty("password", "[REDACTED]");
	});

	it("redacts password one level deep", () => {
		const { logger, getLogs } = createTestLogger(redactOptions);
		logger.info({ config: { password: "hunter2" } }, "config loaded");
		const logs = getLogs();
		expect(logs).toHaveLength(1);
		const config = logs[0]!.config as Record<string, unknown>;
		expect(config.password).toBe("[REDACTED]");
	});

	it("redacts authorization headers", () => {
		const { logger, getLogs } = createTestLogger(redactOptions);
		logger.info({ authorization: "Bearer sk-abc123" }, "request");
		const [entry] = getLogs();
		expect(entry).toHaveProperty("authorization", "[REDACTED]");
	});

	it("redacts nested Authorization headers", () => {
		const { logger, getLogs } = createTestLogger(redactOptions);
		logger.info(
			{ headers: { Authorization: "Bearer sk-abc123" } },
			"request",
		);
		const logs = getLogs();
		expect(logs).toHaveLength(1);
		const headers = logs[0]!.headers as Record<string, unknown>;
		expect(headers.Authorization).toBe("[REDACTED]");
	});

	it("leaves non-sensitive fields untouched", () => {
		const { logger, getLogs } = createTestLogger(redactOptions);
		logger.info({ username: "alice", password: "hunter2" }, "login");
		const [entry] = getLogs();
		expect(entry).toHaveProperty("username", "alice");
		expect(entry).toHaveProperty("password", "[REDACTED]");
	});

	// Explicitly assert what the wildcard does and doesn't cover. This is
	// the test that would have caught `**.password` being treated as a
	// literal key by fast-redact. If someone tries to "widen" the pattern
	// again, at least one of these assertions will fail loudly.
	it("covers exactly top-level and one-level-deep (documented limit)", () => {
		const { logger, getLogs } = createTestLogger(redactOptions);
		logger.info(
			{
				password: "top",
				one: { password: "one-deep" },
				two: { inner: { password: "two-deep" } },
			},
			"depth check",
		);
		const [entry] = getLogs();
		expect(entry!.password).toBe("[REDACTED]");
		expect((entry!.one as Record<string, unknown>).password).toBe("[REDACTED]");
		// fast-redact has no arbitrary-depth wildcard; two-deep is NOT redacted.
		// If this becomes a requirement, enumerate concrete paths.
		const two = entry!.two as Record<string, Record<string, unknown>>;
		expect(two.inner!.password).toBe("two-deep");
	});
});

describe("err serializer", () => {
	beforeEach(() => {
		clearRegisteredSecrets();
	});

	it("redacts a credential embedded in the error message and stack", () => {
		const err = new Error(
			"failed to pull https://user:ghp_abc123@registry.example.com/img",
		);
		const serialized = serializeErr(err);
		expect(serialized.message).not.toContain("ghp_abc123");
		expect(serialized.message).toBe(
			"failed to pull https://user:[REDACTED]@registry.example.com/img",
		);
		expect(serialized.stack).not.toContain("ghp_abc123");
	});

	it("redacts a registered secret embedded in the message", () => {
		registerSecret("registered-secret-value");
		const err = new Error("refused: registered-secret-value");
		const serialized = serializeErr(err);
		expect(serialized.message).toBe("refused: [REDACTED]");
	});

	it("redacts secrets in properties attached to the error object", () => {
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

	it("keeps pino's standard error record shape", () => {
		const err = new Error("plain failure");
		const serialized = serializeErr(err);
		expect(serialized).toHaveProperty("type", "Error");
		expect(serialized).toHaveProperty("message", "plain failure");
		expect(serialized).toHaveProperty("stack");
	});

	it("leaves non-sensitive text untouched", () => {
		const err = new Error("container exited with code 137");
		const serialized = serializeErr(err);
		expect(serialized.message).toBe("container exited with code 137");
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

	it("is wired into the root logger for the `err` field", () => {
		const lines: string[] = [];
		const stream = new Writable({
			write(chunk, _encoding, callback) {
				lines.push(chunk.toString().trim());
				callback();
			},
		});
		const testLogger = pino(
			{
				level: "trace",
				timestamp: pino.stdTimeFunctions.isoTime,
				redact: { paths: [...REDACT_CONFIG.paths], censor: REDACT_CONFIG.censor },
				serializers: { err: serializeErr },
			},
			stream,
		);

		registerSecret("registered-secret-value");
		testLogger.error(
			{ err: new Error("boom: registered-secret-value") },
			"span failed",
		);

		const [entry] = lines.map((line) => JSON.parse(line));
		const loggedErr = entry.err as Record<string, unknown>;
		expect(loggedErr.message).toBe("boom: [REDACTED]");
	});
});

describe("err serializer — NDJSON file", () => {
	// LAUNCHFILE_LOG_DIR is validated against a sensitive-path blocklist that
	// includes "/var" — os.tmpdir() resolves to /var/folders/... on macOS, so
	// the file goes under the package directory instead, cleaned up after.
	//
	// The module builds its file stream from LAUNCHFILE_LOG_DIR at import
	// time, so getting a logger that writes to our temp dir means forcing a
	// fresh module instance with vi.resetModules() — and resetting again
	// afterwards so later tests (`span system`, below) re-import a logger
	// that was never pointed at a directory this test just deleted.
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(process.cwd(), "lf-logger-ndjson-"));
	});

	afterEach(async () => {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.LAUNCHFILE_LOG_DIR;
		vi.resetModules();
	});

	it("scrubs a credential-bearing error from the on-disk NDJSON file", async () => {
		process.env.LAUNCHFILE_LOG_DIR = dir;
		vi.resetModules();
		const fresh = await import("../logger.js");
		const freshRedact = await import("../redact.js");
		freshRedact.registerSecret("registered-secret-value");

		const err = Object.assign(
			new Error(
				"failed https://user:hunter2pass@host.example.com/x and registered-secret-value",
			),
			{ display: "curl registered-secret-value" },
		);
		fresh.logger.error({ err }, "span failed");

		// The file destination opens and writes asynchronously (mkdir + fd
		// open happen off the constructor call), so poll rather than assume
		// a single flush() call has already landed the write.
		const logPath = join(dir, "launchfile-docker.log");
		let contents = "";
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline) {
			try {
				contents = readFileSync(logPath, "utf8");
				if (contents.includes("span failed")) break;
			} catch {
				// file not created yet
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(contents).not.toContain("hunter2pass");
		expect(contents).not.toContain("registered-secret-value");
		expect(contents).toContain("[REDACTED]");
		expect(contents).toContain("span failed");
	});
});

describe("span system", () => {
	// The span system uses a module-scoped AsyncLocalStorage. Testing the
	// real module exercises the real context propagation behaviour.
	let logger: typeof import("../logger.js");

	beforeEach(async () => {
		logger = await import("../logger.js");
	});

	describe("withSpan success path", () => {
		it("returns the function's result", async () => {
			const result = await logger.withSpan("test-op", {}, async () => 42);
			expect(result).toBe(42);
		});

		it("makes span context available via getLogger inside the function", async () => {
			let innerLogger: ReturnType<typeof logger.getLogger> | undefined;
			await logger.withSpan("ctx-test", { slug: "ghost" }, async () => {
				innerLogger = logger.getLogger();
			});
			expect(innerLogger).toBeDefined();
			// The inner logger is a child logger with span context, not the root
			expect(innerLogger).not.toBe(logger.logger);
		});

		it("exposes the current span via currentSpan()", async () => {
			let captured: ReturnType<typeof logger.currentSpan>;
			await logger.withSpan("span-test", { key: "value" }, async () => {
				captured = logger.currentSpan();
			});
			expect(captured).toBeDefined();
			expect(captured?.operation).toBe("span-test");
			expect(captured?.metadata).toEqual({ key: "value" });
			expect(captured?.id).toMatch(/^[a-f0-9-]+$/);
		});

		it("clears span context after the function returns", async () => {
			await logger.withSpan("ephemeral", {}, async () => {});
			expect(logger.currentSpan()).toBeUndefined();
		});
	});

	describe("withSpan error path", () => {
		it("re-throws the original error", async () => {
			await expect(
				logger.withSpan("failing", {}, async () => {
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
		});

		it("still clears span context after an error", async () => {
			await expect(
				logger.withSpan("failing", {}, async () => {
					throw new Error("boom");
				}),
			).rejects.toThrow();
			expect(logger.currentSpan()).toBeUndefined();
		});
	});

	describe("nested spans", () => {
		it("child span references parent via parentId", async () => {
			let parentId: string | undefined;
			let childParentId: string | undefined;

			await logger.withSpan("parent", {}, async () => {
				parentId = logger.currentSpan()?.id;
				await logger.withSpan("child", {}, async () => {
					childParentId = logger.currentSpan()?.parentId;
				});
			});

			expect(parentId).toBeDefined();
			expect(childParentId).toBe(parentId);
		});
	});

	describe("withSpanSync", () => {
		it("works for synchronous operations", () => {
			const result = logger.withSpanSync("sync-op", {}, () => "done");
			expect(result).toBe("done");
		});

		it("re-throws synchronous errors", () => {
			expect(() =>
				logger.withSpanSync("sync-fail", {}, () => {
					throw new Error("sync boom");
				}),
			).toThrow("sync boom");
		});
	});

	describe("getLogger outside a span", () => {
		it("returns the root logger", () => {
			const log = logger.getLogger();
			expect(log).toBe(logger.logger);
		});
	});
});
