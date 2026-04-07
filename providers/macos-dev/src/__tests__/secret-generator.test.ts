import { describe, it, expect } from "vitest";
import { generateValue, generatePassword } from "../secret-generator.js";

describe("generateValue", () => {
	it("generates a base64url secret", async () => {
		const value = await generateValue("secret");
		expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(value.length).toBeGreaterThan(20);
	});

	it("generates a UUID", async () => {
		const value = await generateValue("uuid");
		expect(value).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("generates unique values each time", async () => {
		const a = await generateValue("secret");
		const b = await generateValue("secret");
		expect(a).not.toBe(b);
	});
});

describe("generatePassword", () => {
	it("generates a URL-safe password", () => {
		const pw = generatePassword();
		expect(pw).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(pw.length).toBeGreaterThan(10);
	});
});
