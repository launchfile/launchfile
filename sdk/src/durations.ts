/**
 * The ratified duration grammar (D-48): an integer immediately followed by
 * exactly one unit — `^(\d+)(ms|s|m|h)$`. No internal whitespace, no compound
 * values ("1m30s"), no fractions. It governs `commands.*.timeout` and the
 * `health` durations (`interval`, `timeout`, `start_period`).
 *
 * An unparseable duration is a lint warning at `validate` time (non-fatal —
 * `valid` is unaffected). Providers MUST NOT silently substitute a default
 * for an unparseable value; they surface the error (PROVIDERS.md §10).
 */

import type { NormalizedLaunch } from "./types.js";

/** One duration grammar, everywhere a duration appears (P-9). */
export const DURATION_PATTERN = /^(\d+)(ms|s|m|h)$/;

/** True when `value` matches the ratified duration grammar. */
export function isValidDuration(value: string): boolean {
	return DURATION_PATTERN.test(value);
}

/**
 * Parse a duration string ("500ms", "30s", "5m", "2h") into milliseconds.
 * Throws on any value outside the grammar — callers surface the error with
 * the disposition of the stage the duration belongs to; they never fall
 * back to a default.
 */
export function parseDurationMs(value: string): number {
	const match = DURATION_PATTERN.exec(value);
	if (!match) {
		throw new Error(
			`invalid duration "${value}" — expected an integer followed by ms, s, m, or h (e.g. "30s", "5m")`,
		);
	}
	const n = Number.parseInt(match[1]!, 10);
	switch (match[2]) {
		case "ms":
			return n;
		case "s":
			return n * 1000;
		case "m":
			return n * 60 * 1000;
		default:
			return n * 60 * 60 * 1000;
	}
}

/**
 * Lint every duration-valued field in a normalized Launch against the
 * grammar: `commands.*.timeout` plus `health.interval` / `health.timeout` /
 * `health.start_period`, per component. Returns human-readable warning
 * strings (empty = clean), matching the `lintLaunch` warning channel.
 */
export function lintDurations(launch: NormalizedLaunch): string[] {
	const warnings: string[] = [];

	const warn = (componentName: string, field: string, value: string): void => {
		const where =
			componentName === "default" ? field : `${componentName}: ${field}`;
		warnings.push(
			`${where}: "${value}" is not a valid duration — ` +
				`use an integer followed by ms, s, m, or h (e.g. "30s", "5m")`,
		);
	};

	for (const [componentName, component] of Object.entries(launch.components)) {
		for (const [commandName, command] of Object.entries(
			component.commands ?? {},
		)) {
			if (command?.timeout !== undefined && !isValidDuration(command.timeout)) {
				warn(componentName, `commands.${commandName}.timeout`, command.timeout);
			}
		}

		const health = component.health;
		if (health) {
			for (const field of ["interval", "timeout", "start_period"] as const) {
				const value = health[field];
				if (value !== undefined && !isValidDuration(value)) {
					warn(componentName, `health.${field}`, value);
				}
			}
		}
	}

	return warnings;
}
