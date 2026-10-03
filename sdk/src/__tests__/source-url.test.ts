import { describe, expect, it } from "vitest";
import {
	CREDENTIAL_QUERY_KEYS,
	canonicalSourceUrl,
	isCredentialQueryKey,
} from "../source-url.js";

describe("canonicalSourceUrl", () => {
	it("removes userinfo and credential query values, keeping everything else", () => {
		const out = canonicalSourceUrl(
			"https://user:tok@host.example:8443/x/Launchfile?token=t&ref=v1#main",
		);
		expect(out).toBe("https://host.example:8443/x/Launchfile?ref=v1#main");
		expect(out).not.toContain("user");
		expect(out).not.toContain("tok");
		expect(out).not.toContain("token");
	});

	it("removes a bare token in the username slot", () => {
		expect(canonicalSourceUrl("https://ghp_abc123@github.com/a/b")).toBe(
			"https://github.com/a/b",
		);
	});

	it("drops the query entirely when every parameter is a credential", () => {
		expect(
			canonicalSourceUrl("https://h.example/x?access_token=a&private_token=b"),
		).toBe("https://h.example/x");
	});

	it("covers every key the issue names, case-insensitively", () => {
		for (const key of [
			"token",
			"access_token",
			"private_token",
			"auth",
			"key",
			"password",
			"secret",
			"sig",
			"signature",
		]) {
			expect(CREDENTIAL_QUERY_KEYS).toContain(key);
			expect(isCredentialQueryKey(key.toUpperCase())).toBe(true);
			expect(
				canonicalSourceUrl(`https://h.example/x?${key}=s3cr3t&ref=v1`),
			).toBe("https://h.example/x?ref=v1");
		}
		expect(canonicalSourceUrl("https://h.example/x?Token=s3cr3t")).toBe(
			"https://h.example/x",
		);
	});

	it("removes a repeated credential key", () => {
		expect(canonicalSourceUrl("https://h.example/x?sig=a&sig=b&v=1")).toBe(
			"https://h.example/x?v=1",
		);
	});

	it("leaves a URL with no credential byte-for-byte unchanged in its query", () => {
		expect(canonicalSourceUrl("https://h.example/x?q=a+b&ref=v1")).toBe(
			"https://h.example/x?q=a+b&ref=v1",
		);
	});

	it("maps two credentials for one source to the same identity", () => {
		expect(canonicalSourceUrl("https://old:tok1@h.example/x?token=a")).toBe(
			canonicalSourceUrl("https://new:tok2@h.example/x?token=b"),
		);
	});

	it("keeps host, port, path, ref query and fragment distinct", () => {
		const base = canonicalSourceUrl("https://h.example/x?ref=v1#main");
		for (const other of [
			"https://other.example/x?ref=v1#main",
			"https://h.example:8443/x?ref=v1#main",
			"https://h.example/y?ref=v1#main",
			"https://h.example/x?ref=v2#main",
			"https://h.example/x?ref=v1#v2",
		]) {
			expect(canonicalSourceUrl(other)).not.toBe(base);
		}
	});

	it("is idempotent", () => {
		const once = canonicalSourceUrl(
			"HTTPS://u:p@H.Example:443/x?token=t&ref=v1#r",
		);
		expect(once).toBe("https://h.example/x?ref=v1#r");
		expect(canonicalSourceUrl(once)).toBe(once);
	});

	it("returns a non-URL unchanged", () => {
		for (const value of [
			"ghost",
			"/Users/me/app",
			"C:\\app\\Launchfile",
			"catalog:ghost",
			"",
		]) {
			expect(canonicalSourceUrl(value)).toBe(value);
		}
	});

	it("still removes credentials from a scheme:// string the URL parser rejects", () => {
		const out = canonicalSourceUrl(
			"https://user:tok@bad host/x?token=t&ref=v1#main",
		);
		expect(out).toBe("https://bad host/x?ref=v1#main");
		expect(out).not.toContain("tok");
	});
});
