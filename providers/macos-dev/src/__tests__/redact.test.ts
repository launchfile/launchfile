import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearRegisteredSecrets,
	REDACTED,
	redactSecrets,
	registerSecret,
	registerSecrets,
} from "../redact.js";
import { generatePassword, generateValue } from "../secret-generator.js";
import { shell } from "../shell.js";

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
		const out = redactSecrets("s3cret-value-abc and s3cret-value-abc");
		expect(out).not.toContain("s3cret-value-abc");
		expect(out).toBe(`${REDACTED} and ${REDACTED}`);
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

	it("ignores values too short to be registered safely", () => {
		registerSecret("abc");
		expect(redactSecrets("abc def")).toBe("abc def");
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

describe("secret generators register their output", () => {
	it("registers a generated password", () => {
		const password = generatePassword();
		expect(redactSecrets(`createuser --password ${password}`)).not.toContain(
			password,
		);
	});

	it("registers a generated `secret` value", async () => {
		const secret = await generateValue("secret");
		expect(redactSecrets(secret)).toBe(REDACTED);
	});
});

describe("shell command echo", () => {
	let logged: string[];
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logged = [];
		logSpy = vi
			.spyOn(console, "log")
			.mockImplementation((...args: unknown[]) => {
				logged.push(args.map(String).join(" "));
			});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	// This is the regression test for code-scanning alert #21
	// (js/clear-text-logging at shell.ts:30). Without redaction at the echo,
	// the generated password appears verbatim on stdout.
	it("never echoes a generated password in the command it prints", async () => {
		const password = generatePassword();
		await shell(`echo ${password} > /dev/null`);
		expect(logged.join("\n")).not.toContain(password);
		expect(logged.join("\n")).toContain(REDACTED);
	});

	it("keeps the non-secret part of the command readable", async () => {
		const password = generatePassword();
		await shell(`echo ${password} > /dev/null`);
		expect(logged.join("\n")).toContain("echo");
	});

	it("does not echo the command at all when silent", async () => {
		const password = generatePassword();
		await shell(`echo ${password} > /dev/null`, { silent: true });
		expect(logged).toHaveLength(0);
	});
});

describe("shell failure errors", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps a generated password out of the thrown error message", async () => {
		const password = generatePassword();
		await expect(shell(`false ${password}`)).rejects.toThrow();
		await shell(`false ${password}`).catch((err: unknown) => {
			expect((err as Error).message).not.toContain(password);
			expect((err as Error).message).toContain(REDACTED);
		});
	});

	it("keeps a secret echoed back on stderr out of the error message", async () => {
		const password = generatePassword();
		await shell(`echo ${password} >&2; exit 1`).catch((err: unknown) => {
			expect((err as Error).message).not.toContain(password);
		});
	});
});
