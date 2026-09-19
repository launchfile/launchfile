/**
 * D-58's publication-URL contract, owned by the SDK so every provider raises
 * the same refusal: `normalizeAppUrl` validation (refuse, never degrade),
 * `InvalidAppUrlError`'s credential masking (D-18), and the `$app.*` set a
 * supplied URL determines (D-33, D-35).
 */

import { describe, expect, it } from "vitest";
import {
	InvalidAppUrlError,
	normalizeAppUrl,
	suppliedAppAddress,
	suppliedAppProperties,
} from "../app-url.js";

function refusalOf(value: string): Error {
	try {
		normalizeAppUrl(value);
	} catch (e) {
		return e as Error;
	}
	throw new Error(`expected ${value} to be refused`);
}

describe("normalizeAppUrl (D-58 rule 3)", () => {
	it("accepts a plain https URL and drops the lone root-path slash", () => {
		expect(normalizeAppUrl("https://notes.example.com")).toBe(
			"https://notes.example.com",
		);
		expect(normalizeAppUrl("https://notes.example.com/")).toBe(
			"https://notes.example.com",
		);
	});

	it("accepts http, explicit ports, and preserves a non-root path verbatim", () => {
		expect(normalizeAppUrl("http://intranet.local:8080")).toBe(
			"http://intranet.local:8080",
		);
		expect(normalizeAppUrl("https://example.com/notes")).toBe(
			"https://example.com/notes",
		);
		// A trailing slash on a NON-root path is content, not noise.
		expect(normalizeAppUrl("https://example.com/notes/")).toBe(
			"https://example.com/notes/",
		);
	});

	it("normalizes via WHATWG serialization (default port dropped, host lowercased)", () => {
		expect(normalizeAppUrl("HTTPS://Notes.Example.COM:443/")).toBe(
			"https://notes.example.com",
		);
		expect(normalizeAppUrl("http://x.example.com:80")).toBe(
			"http://x.example.com",
		);
	});

	it("is idempotent", () => {
		const once = normalizeAppUrl("https://example.com/notes/");
		expect(normalizeAppUrl(once)).toBe(once);
	});

	it("refuses an unparseable value", () => {
		for (const bad of ["notes.example.com", "", "https://", "not a url"]) {
			expect(() => normalizeAppUrl(bad)).toThrow(InvalidAppUrlError);
		}
	});

	it("refuses a non-http(s) scheme", () => {
		expect(() => normalizeAppUrl("ftp://example.com")).toThrow(
			InvalidAppUrlError,
		);
		expect(() => normalizeAppUrl("ws://example.com")).toThrow(
			InvalidAppUrlError,
		);
	});

	it("refuses a query string", () => {
		expect(() => normalizeAppUrl("https://example.com/?x=1")).toThrow(
			InvalidAppUrlError,
		);
	});

	it("refuses a fragment", () => {
		expect(() => normalizeAppUrl("https://example.com/#top")).toThrow(
			InvalidAppUrlError,
		);
	});

	it("refuses userinfo — and never echoes the credential back (D-18)", () => {
		const err = refusalOf("https://admin:hunter2@example.com/app");
		expect(err).toBeInstanceOf(InvalidAppUrlError);
		expect(err.message).not.toContain("hunter2");
		expect(err.message).not.toContain("admin");
		expect(err.message).toContain("***@example.com");
		expect(err.message).toContain("userinfo");
	});

	it("never echoes a credential from ANY refusal branch", () => {
		// The mask lives in the InvalidAppUrlError constructor, so every branch
		// is covered — including ones where userinfo is not the refusal reason.
		const cases: Array<[string, string]> = [
			// scheme branch fires before the userinfo check
			["ftp://admin:hunter2@example.com", 'scheme "ftp"'],
			// slash-less special-scheme form the WHATWG parser still accepts
			["ftp:admin:hunter2@example.com", 'scheme "ftp"'],
			// parse failure — no URL object, textual mask only
			["http://admin:hunter2@[invalid", "not a parseable"],
			// userinfo-shaped text inside a refused query / fragment
			["https://example.com/?next=admin:hunter2@internal", "query"],
			["https://example.com/#admin:hunter2@internal", "fragment"],
		];
		for (const [bad, reason] of cases) {
			const err = refusalOf(bad);
			expect(err).toBeInstanceOf(InvalidAppUrlError);
			expect(err.message).not.toContain("hunter2");
			expect(err.message).toContain("***@");
			expect(err.message).toContain(reason);
		}
	});

	it("names the option and states the expectation in the refusal", () => {
		const err = refusalOf("ftp://example.com");
		expect(err.message).toContain("appUrl");
		expect(err.message).toContain("http:// or https://");
		expect((err as { expectedRefusal?: boolean }).expectedRefusal).toBe(true);
	});
});

describe("suppliedAppProperties (D-58 rule 2)", () => {
	it("resolves the full property set from the supplied URL", () => {
		expect(suppliedAppProperties("notes", "https://notes.example.com")).toEqual(
			{
				name: "notes",
				host: "notes.example.com",
				port: 443,
				url: "https://notes.example.com",
				authority: "notes.example.com",
				scheme: "https",
				tls: "true",
			},
		);
	});

	it("uses the scheme default port for http and the explicit port when given", () => {
		expect(
			suppliedAppProperties("notes", "http://intranet.local"),
		).toMatchObject({
			port: 80,
			tls: "false",
			scheme: "http",
		});
		expect(
			suppliedAppProperties("notes", "https://x.example.com:8443"),
		).toMatchObject({
			port: 8443,
			authority: "x.example.com:8443",
			url: "https://x.example.com:8443",
		});
	});

	it("keeps a subpath in $app.url while authority/host drop it", () => {
		expect(
			suppliedAppProperties("notes", "https://example.com/notes"),
		).toMatchObject({
			url: "https://example.com/notes",
			authority: "example.com",
			host: "example.com",
		});
	});

	it("refuses a malformed value instead of returning a degraded set", () => {
		expect(() => suppliedAppProperties("notes", "notes.example.com")).toThrow(
			InvalidAppUrlError,
		);
	});
});

describe("suppliedAppAddress (D-58 rule 2)", () => {
	it("is the property set minus name — one derivation, whichever a provider reads", () => {
		for (const url of [
			"https://notes.example.com",
			"http://intranet.local",
			"https://x.example.com:8443",
			"https://example.com/notes",
		]) {
			const { name, ...address } = suppliedAppProperties("notes", url);
			expect(name).toBe("notes");
			expect(suppliedAppAddress(url)).toEqual(address);
		}
	});

	it("refuses a malformed value instead of returning a degraded address", () => {
		expect(() => suppliedAppAddress("notes.example.com")).toThrow(
			InvalidAppUrlError,
		);
	});
});
