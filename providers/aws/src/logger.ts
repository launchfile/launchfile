/**
 * Structured logging for the AWS provider — pino to stderr, per repo convention.
 * User-facing CLI output goes to stdout via `process.stdout.write` (cli.ts); the
 * two streams never mix. Translation itself is pure, so logging is sparse.
 */

import pino from "pino";

export const REDACT_PATHS: readonly string[] = [
	"*.password",
	"*.secret",
	"*.token",
	"*.value",
	"password",
	"secret",
	"token",
];

let logger: pino.Logger | undefined;

export function getLogger(): pino.Logger {
	if (!logger) {
		logger = pino({
			level: process.env.LAUNCHFILE_LOG_LEVEL ?? "info",
			redact: { paths: [...REDACT_PATHS], censor: "[REDACTED]" },
		});
	}
	return logger;
}
