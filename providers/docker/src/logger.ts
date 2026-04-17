/**
 * Structured logging and operation tracing for the Launchfile Docker provider.
 *
 * Uses pino for structured JSON output with AsyncLocalStorage for
 * automatic span context propagation across async boundaries.
 *
 * By default, logs go to stderr via pino-pretty (so they don't mix with
 * stdout user-facing CLI output). If LAUNCHFILE_LOG_DIR is set, also
 * writes NDJSON to a file in that directory.
 *
 * Usage:
 *   import { getLogger, withSpan } from "./logger.js";
 *
 *   // Inside a span (context auto-propagated):
 *   getLogger().info({ slug }, "app started");
 *
 *   // Create a traced operation:
 *   const result = await withSpan("up", { slug }, async () => {
 *     return startContainers();
 *   });
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import pino from "pino";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Span {
	/** Unique span identifier */
	id: string;
	/** Operation name (e.g. "up", "down", "health-check") */
	operation: string;
	/** Parent span ID for nested operations */
	parentId?: string;
	/** High-resolution start time */
	startedAt: number;
	/** Arbitrary metadata attached at span creation */
	metadata: Record<string, unknown>;
	/** Child logger with span context baked in */
	logger: pino.Logger;
}

export type SpanOutcome = "ok" | "error";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const level = process.env.LAUNCHFILE_LOG_LEVEL ?? "info";

const SENSITIVE_ROOTS = ["/", "/etc", "/var", "/var/log", "/usr", "/bin", "/sbin"];

function validateLogDir(dir: string): void {
	if (!isAbsolute(dir)) {
		throw new Error(`LAUNCHFILE_LOG_DIR must be an absolute path, got: ${dir}`);
	}
	const sshDir = join(homedir(), ".ssh");
	const blocked = [...SENSITIVE_ROOTS, sshDir];
	if (blocked.some((s) => dir === s || dir.startsWith(s + "/"))) {
		throw new Error(`LAUNCHFILE_LOG_DIR points to a sensitive path: ${dir}`);
	}
}

const rawLogDir = process.env.LAUNCHFILE_LOG_DIR;
if (rawLogDir !== undefined) validateLogDir(rawLogDir);
const logDir = rawLogDir;

/**
 * Build pino's transport config. Uses the pino worker-thread transport API
 * which is ESM-safe (works without `require` in Node's native ESM).
 */
function buildTransport(): pino.TransportMultiOptions | pino.TransportSingleOptions {
	const prettyTarget = {
		target: "pino-pretty",
		options: {
			colorize: true,
			translateTime: "HH:MM:ss.l",
			ignore: "pid,hostname,service",
			destination: 2, // stderr — keeps structured logs off stdout (CLI UI)
		},
	};

	if (logDir) {
		return {
			targets: [
				{ ...prettyTarget, level: level as pino.Level },
				{
					target: "pino/file",
					options: {
						destination: join(logDir, "launchfile-docker.log"),
						mkdir: true,
						mode: 0o600,
					},
					level: "trace" as pino.Level,
				},
			],
		};
	}

	return prettyTarget;
}

// ---------------------------------------------------------------------------
// Redaction config
// ---------------------------------------------------------------------------

// pino uses fast-redact, which supports `*` as a single-level wildcard but
// has no arbitrary-depth wildcard. `**.field` is treated as a literal key
// named "**", not a deep match — see fast-redact docs. If we ever need to
// redact secrets nested more than one level deep, enumerate the concrete
// paths (e.g., "config.db.password") or add a custom censor function.
export const REDACT_PATHS: readonly string[] = [
	// One level deep (matches foo.password, config.password, etc.)
	"*.password",
	"*.secret",
	"*.token",
	"*.apiKey",
	"*.api_key",
	"*.authorization",
	"*.Authorization",
	"*.cookie",
	"*.Cookie",
	// Top level
	"password",
	"secret",
	"token",
	"apiKey",
	"api_key",
	"authorization",
	"Authorization",
];

export const REDACT_CONFIG = {
	paths: [...REDACT_PATHS],
	censor: "[REDACTED]",
} as const;

// ---------------------------------------------------------------------------
// Root logger
// ---------------------------------------------------------------------------

export const logger: pino.Logger = pino({
	// When a file target is active, keep the root level at trace and let each
	// transport target filter independently. Otherwise honour the configured level.
	level: logDir ? "trace" : level,
	transport: buildTransport(),
	base: { service: "launchfile-docker" },
	timestamp: pino.stdTimeFunctions.isoTime,
	redact: {
		paths: [...REDACT_PATHS],
		censor: REDACT_CONFIG.censor,
	},
});

// ---------------------------------------------------------------------------
// Span / tracing via AsyncLocalStorage
// ---------------------------------------------------------------------------

const spanStorage = new AsyncLocalStorage<Span>();

function generateSpanId(): string {
	return randomUUID().slice(0, 12);
}

/**
 * Start a new span. Automatically nests under the current span if one exists.
 * Prefer `withSpan()` which handles start/end lifecycle automatically.
 */
export function startSpan(
	operation: string,
	metadata: Record<string, unknown> = {},
): Span {
	const parent = spanStorage.getStore();
	const id = generateSpanId();

	const childFields: Record<string, unknown> = {
		spanId: id,
		operation,
		...metadata,
	};
	if (parent) {
		childFields.parentSpanId = parent.id;
	}

	const spanLogger = (parent?.logger ?? logger).child(childFields);
	spanLogger.debug("span started");

	return {
		id,
		operation,
		parentId: parent?.id,
		startedAt: performance.now(),
		metadata,
		logger: spanLogger,
	};
}

/**
 * End a span, logging its outcome and duration.
 */
export function endSpan(
	span: Span,
	outcome: SpanOutcome,
	error?: Error,
): void {
	const durationMs = Math.round(performance.now() - span.startedAt);

	if (outcome === "error" && error) {
		span.logger.error({ durationMs, err: error }, "span failed");
	} else if (outcome === "error") {
		span.logger.error({ durationMs }, "span failed");
	} else {
		span.logger.info({ durationMs }, "span completed");
	}
}

/**
 * Run a function inside a traced span. The span context is automatically
 * available to all code called within `fn` via `getLogger()` / `currentSpan()`.
 *
 * On success, logs span completion with duration.
 * On error, logs the error with duration, then re-throws.
 */
export async function withSpan<T>(
	operation: string,
	metadata: Record<string, unknown>,
	fn: () => Promise<T>,
): Promise<T> {
	const span = startSpan(operation, metadata);
	return spanStorage.run(span, async () => {
		try {
			const result = await fn();
			endSpan(span, "ok");
			return result;
		} catch (err) {
			endSpan(span, "error", err instanceof Error ? err : new Error(String(err)));
			throw err;
		}
	});
}

/**
 * Synchronous variant of `withSpan` for non-async operations.
 */
export function withSpanSync<T>(
	operation: string,
	metadata: Record<string, unknown>,
	fn: () => T,
): T {
	const span = startSpan(operation, metadata);
	return spanStorage.run(span, () => {
		try {
			const result = fn();
			endSpan(span, "ok");
			return result;
		} catch (err) {
			endSpan(span, "error", err instanceof Error ? err : new Error(String(err)));
			throw err;
		}
	});
}

/**
 * Get the current span, if one is active.
 */
export function currentSpan(): Span | undefined {
	return spanStorage.getStore();
}

/**
 * Get the logger for the current context. Returns the span's child logger
 * if inside a span, otherwise the root logger.
 *
 * This is the primary way to log from any module — no need to import
 * or pass logger instances.
 */
export function getLogger(): pino.Logger {
	return spanStorage.getStore()?.logger ?? logger;
}
