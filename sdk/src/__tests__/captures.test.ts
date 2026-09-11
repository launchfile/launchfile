/**
 * Capture display (SPEC.md § Command Capture, D-62): `sensitive` masks on
 * every display surface; `reveal` is the operator's explicit act; the hint
 * tells a first-time operator the act exists.
 */

import { describe, expect, it } from "vitest";
import {
	CAPTURE_MASK,
	formatCaptures,
	REVEAL_HINT,
	sensitiveCaptureValues,
} from "../captures.js";
import type { CaptureEntry } from "../types.js";

const meta: Record<string, CaptureEntry> = {
	invite_link: {
		pattern: "https?://\\S+",
		description: "One-time invite link",
		sensitive: true,
	},
	admin_user: { pattern: "user: (\\S+)", description: "Admin login" },
};

const captures = {
	invite_link: "https://acme.test/invite/abc123",
	admin_user: "admin",
};

describe("formatCaptures", () => {
	it("masks a sensitive capture by default and appends one hint line", () => {
		expect(formatCaptures(captures, meta, false)).toEqual([
			"  Captured:",
			`    invite_link: ${CAPTURE_MASK} — One-time invite link`,
			"    admin_user: admin — Admin login",
			`  ${REVEAL_HINT}`,
		]);
	});

	it("prints the sensitive value under reveal, with no hint", () => {
		const lines = formatCaptures(captures, meta, true);
		expect(lines).toEqual([
			"  Captured:",
			"    invite_link: https://acme.test/invite/abc123 — One-time invite link",
			"    admin_user: admin — Admin login",
		]);
		expect(lines.join("\n")).not.toContain(REVEAL_HINT);
	});

	it("prints non-sensitive captures identically in both modes", () => {
		const masked = formatCaptures({ admin_user: "admin" }, meta, false);
		const revealed = formatCaptures({ admin_user: "admin" }, meta, true);
		expect(masked).toEqual(revealed);
		expect(masked).toEqual([
			"  Captured:",
			"    admin_user: admin — Admin login",
		]);
	});

	it("omits the hint when nothing was masked", () => {
		expect(
			formatCaptures({ admin_user: "admin" }, meta, false).join("\n"),
		).not.toContain(REVEAL_HINT);
	});

	it("omits the hint where the caller says no reveal path exists", () => {
		const lines = formatCaptures(captures, meta, false, { hint: false });
		expect(lines).toEqual([
			"  Captured:",
			`    invite_link: ${CAPTURE_MASK} — One-time invite link`,
			"    admin_user: admin — Admin login",
		]);
		expect(lines.join("\n")).not.toContain("abc123");
	});

	it("returns no lines when nothing was captured", () => {
		expect(formatCaptures({}, meta, false)).toEqual([]);
		expect(formatCaptures({}, meta, true)).toEqual([]);
	});

	it("treats a capture with no entry as non-sensitive", () => {
		expect(formatCaptures({ extra: "x" }, {}, false)).toEqual([
			"  Captured:",
			"    extra: x",
		]);
	});

	it("names the exact command in the hint", () => {
		expect(REVEAL_HINT).toContain("launchfile bootstrap --reveal");
	});
});

describe("sensitiveCaptureValues", () => {
	it("returns the values of sensitive captures only", () => {
		expect(sensitiveCaptureValues(captures, meta)).toEqual([
			"https://acme.test/invite/abc123",
		]);
	});

	it("returns nothing when no capture is sensitive", () => {
		expect(sensitiveCaptureValues({ admin_user: "admin" }, meta)).toEqual([]);
		expect(sensitiveCaptureValues({ extra: "x" }, {})).toEqual([]);
	});
});
