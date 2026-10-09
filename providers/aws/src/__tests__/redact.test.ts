import { readLaunch } from "@launchfile/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearRegisteredSecrets,
	REDACTED,
	redactSecrets,
	registerDeclaredSecret,
	registerSecret,
	registerSecrets,
} from "../redact.js";
import { translate } from "../translate.js";

beforeEach(() => {
	clearRegisteredSecrets();
});

describe("redactSecrets", () => {
	it("scrubs a registered secret from arbitrary text", () => {
		registerSecret("s3cret-value-abc");
		expect(redactSecrets("psql -c \"PASSWORD 's3cret-value-abc'\"")).toBe(
			`psql -c "PASSWORD '${REDACTED}'"`,
		);
	});

	it("scrubs every occurrence, not just the first", () => {
		registerSecret("s3cret-value-abc");
		expect(redactSecrets("s3cret-value-abc and s3cret-value-abc")).toBe(
			`${REDACTED} and ${REDACTED}`,
		);
	});

	it("scrubs a registered password nested inside its own connection URL", () => {
		registerSecret("longpassword123");
		expect(
			redactSecrets("postgresql://user:longpassword123@localhost:5432/db"),
		).toBe(`postgresql://user:${REDACTED}@localhost:5432/db`);
	});

	it("scrubs URL-embedded credentials that were never registered", () => {
		expect(redactSecrets("curl https://alice:hunter2@example.com/api")).toBe(
			`curl https://alice:${REDACTED}@example.com/api`,
		);
	});

	it("leaves a URL without credentials untouched", () => {
		const text = "curl http://localhost:3000/health";
		expect(redactSecrets(text)).toBe(text);
	});

	it("still redacts a scheme longer than the bound (unanchored match)", () => {
		const scheme = "microsoft.windows.camera.multipicker";
		expect(redactSecrets(`${scheme}://alice:hunter2@example.com`)).toContain(
			`:${REDACTED}@example.com`,
		);
	});

	it("stays linear on a long run of scheme-legal characters (CWE-1333)", () => {
		// No `://` ever arrives, so every starting offset is a candidate scheme.
		const hostile = `${"a".repeat(80_000)}!`;
		const t0 = performance.now();
		expect(redactSecrets(hostile)).toBe(hostile);
		expect(performance.now() - t0).toBeLessThan(250);
	});

	it("ignores values too short to be registered safely", () => {
		registerSecret("abc");
		expect(redactSecrets("abc def")).toBe("abc def");
	});

	it("applies no length floor to a declared secret", () => {
		registerDeclaredSecret("824193");
		expect(redactSecrets("pin 824193 rejected")).toBe(
			`pin ${REDACTED} rejected`,
		);
	});

	it("rejects the empty string as a declared secret", () => {
		registerDeclaredSecret("");
		expect(redactSecrets("untouched")).toBe("untouched");
	});

	it("ignores non-string registry entries", () => {
		registerSecrets([undefined, null, "registered-secret-value"]);
		expect(redactSecrets("registered-secret-value")).toBe(REDACTED);
	});

	it("replaces the longest match first so no partial secret survives", () => {
		registerSecret("abcdefghij");
		registerSecret("abcdefghijklmnop");
		expect(redactSecrets("abcdefghijklmnop")).toBe(REDACTED);
	});
});

describe("translate registers what it declares sensitive (D-18)", () => {
	const yaml = (env: string) => `
version: launch/v1
name: app
runtime: node
env:
${env}
commands:
  start: "node server.js"
`;

	it("registers a sensitive env literal, with no length floor", () => {
		translate(
			readLaunch(
				yaml(`  API_KEY:
    default: literal-api-key-0123456789
    sensitive: true
  PIN:
    default: "824193"
    sensitive: true`),
			),
		);
		expect(redactSecrets("key literal-api-key-0123456789 pin 824193")).toBe(
			`key ${REDACTED} pin ${REDACTED}`,
		);
	});

	it("does not register a literal the file did not mark sensitive", () => {
		translate(
			readLaunch(
				yaml(`  SITE_URL:
    default: https://example.com/public-path-value`),
			),
		);
		const text = "fetch https://example.com/public-path-value";
		expect(redactSecrets(text)).toBe(text);
	});
});
