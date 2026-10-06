/**
 * Structured logging for the AWS provider — pino to stderr, per repo convention.
 * User-facing CLI output goes to stdout via `process.stdout.write` (cli.ts); the
 * two streams never mix. Translation itself is pure, so logging is sparse.
 */

import pino from "pino";
import { redactSecrets } from "./redact.js";

export const REDACT_PATHS: readonly string[] = [
	"*.password",
	"*.secret",
	"*.token",
	"*.value",
	"password",
	"secret",
	"token",
];

/**
 * `redact.paths` only matches object paths — it never sees text inside an
 * `Error.message` or `Error.stack`, or a value copied onto the error object.
 * This walks pino's standard error serializer output and runs `redactSecrets()`
 * over every string it finds, so a credential embedded in prose is caught the
 * same way a `token` field is (D-18).
 */
function deepRedact(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => deepRedact(item, seen));
	// Date, Map, Set and Buffer expose no own enumerable string leaves to
	// scrub, and rebuilding them from entries() erases or explodes them.
	if (
		value instanceof Date ||
		value instanceof Map ||
		value instanceof Set ||
		Buffer.isBuffer(value)
	) {
		return value;
	}
	// Any other object with no own entries (a URL, a class instance with
	// private fields) can still serialize through toJSON() or a getter, e.g. a
	// URL's href carries its userinfo. Rebuild it empty instead of passing it
	// through by identity.
	const entries = Object.entries(value);
	if (entries.length === 0) return {};
	return Object.fromEntries(
		entries.map(([key, val]) => [key, deepRedact(val, seen)]),
	);
}

/** `serializers.err` — see `deepRedact` for why `redact.paths` isn't enough. */
export function serializeErr(err: unknown): Record<string, unknown> {
	const serialized = pino.stdSerializers.err(err as Error) as Record<
		string,
		unknown
	>;
	return deepRedact(serialized) as Record<string, unknown>;
}

/**
 * The provider's logger configuration, bound to `destination` (stderr, fd 2,
 * when omitted). Tests pass a captured stream so they assert against the same
 * redaction config the provider ships, not a copy of it.
 */
export function createLogger(
	destination: pino.DestinationStream = pino.destination(2),
): pino.Logger {
	const options: pino.LoggerOptions = {
		level: process.env.LAUNCHFILE_LOG_LEVEL ?? "info",
		redact: { paths: [...REDACT_PATHS], censor: "[REDACTED]" },
		serializers: { err: serializeErr },
	};
	return pino(options, destination);
}

let logger: pino.Logger | undefined;

export function getLogger(): pino.Logger {
	if (!logger) logger = createLogger();
	return logger;
}
