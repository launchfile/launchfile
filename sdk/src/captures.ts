/**
 * Display of captured command output (SPEC.md § Command Capture).
 *
 * One formatter for every place a provider prints captures, so `sensitive`
 * means the same thing on each: the value is masked on every display surface,
 * the CLI's own stdout included, and shown only when the operator asks on the
 * invoking command (`launchfile bootstrap --reveal`) — the "explicitly
 * revealed" act `CaptureEntry.sensitive` names. The SDK does not print; it
 * returns the lines and the caller writes them.
 *
 * Masking is display only. Whether a sensitive value reaches a log, a state
 * file, or a failure record is the provider's redactor's job, and it must be
 * registered there before this formatter runs.
 */

import type { CaptureEntry } from "./types.js";

/** What a masked capture prints as. */
export const CAPTURE_MASK = "***";

/** Printed once after the capture list when a value was masked. */
export const REVEAL_HINT =
	"(masked — re-run with `launchfile bootstrap --reveal` to print these values)";

export interface FormatCapturesOptions {
	/**
	 * Whether `REVEAL_HINT` follows a masked list. Defaults to true. A stage
	 * with no reveal path (`release`) passes false — a hint naming a command
	 * that does not print its values would be wrong, not merely unhelpful.
	 */
	hint?: boolean;
}

/**
 * The lines a provider prints for one command's captures, indented for the
 * provider's `  Captured:` block. Empty when nothing was captured.
 *
 * `reveal: true` prints every value. Otherwise a capture whose entry declares
 * `sensitive: true` prints as `CAPTURE_MASK`, and one trailing `REVEAL_HINT`
 * line follows if anything was masked. Non-sensitive captures print the same
 * either way.
 */
export function formatCaptures(
	captures: Record<string, string>,
	captureMeta: Record<string, CaptureEntry>,
	reveal: boolean,
	options: FormatCapturesOptions = {},
): string[] {
	const entries = Object.entries(captures);
	if (entries.length === 0) return [];

	const lines = ["  Captured:"];
	let masked = false;
	for (const [key, value] of entries) {
		const meta = captureMeta[key];
		const sensitive = meta?.sensitive === true;
		if (sensitive && !reveal) masked = true;
		const display = sensitive && !reveal ? CAPTURE_MASK : value;
		const desc = meta?.description ? ` — ${meta.description}` : "";
		lines.push(`    ${key}: ${display}${desc}`);
	}
	if (masked && (options.hint ?? true)) lines.push(`  ${REVEAL_HINT}`);
	return lines;
}

/** The values of every capture whose entry declares `sensitive: true`. */
export function sensitiveCaptureValues(
	captures: Record<string, string>,
	captureMeta: Record<string, CaptureEntry>,
): string[] {
	const values: string[] = [];
	for (const [key, value] of Object.entries(captures)) {
		if (captureMeta[key]?.sensitive === true) values.push(value);
	}
	return values;
}
