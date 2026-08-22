import { describe, expect, it } from "vitest";
import { readLaunch } from "../reader.js";
import { parseRepository } from "../repository.js";
import { writeLaunch } from "../writer.js";

// The metadata fields (repository/website/logo/keywords) are declared in the
// JSON Schema and used across the catalog; the Zod schema must carry them so
// providers can read the source origin (D-43) and round-trips preserve them.

describe("parseRepository", () => {
	it("returns the bare URL with no ref when there is no fragment", () => {
		expect(parseRepository("https://github.com/hedgedoc/hedgedoc")).toEqual({
			url: "https://github.com/hedgedoc/hedgedoc",
		});
	});

	it("splits a branch fragment into url and ref", () => {
		expect(parseRepository("https://github.com/hedgedoc/hedgedoc#develop")).toEqual({
			url: "https://github.com/hedgedoc/hedgedoc",
			ref: "develop",
		});
	});

	it("accepts tag and SHA refs", () => {
		expect(parseRepository("https://github.com/example/app#v2.1.0").ref).toBe("v2.1.0");
		expect(parseRepository("https://github.com/example/app#a1b2c3d").ref).toBe("a1b2c3d");
	});

	it("splits at the first '#' only", () => {
		expect(parseRepository("https://github.com/example/app#feature#x")).toEqual({
			url: "https://github.com/example/app",
			ref: "feature#x",
		});
	});

	it("treats an empty fragment as no ref", () => {
		expect(parseRepository("https://github.com/example/app#")).toEqual({
			url: "https://github.com/example/app",
		});
	});
});

describe("metadata fields", () => {
	const yaml = `
name: my-app
description: "An app"
repository: https://github.com/example/my-app#main
website: https://example.com
logo: https://example.com/logo.png
keywords: [blog, cms]
image: ghcr.io/example/my-app:latest
`;

	it("carries repository, website, logo, and keywords through normalization", () => {
		const launch = readLaunch(yaml);
		expect(launch.repository).toBe("https://github.com/example/my-app#main");
		expect(launch.website).toBe("https://example.com");
		expect(launch.logo).toBe("https://example.com/logo.png");
		expect(launch.keywords).toEqual(["blog", "cms"]);
	});

	it("preserves metadata through a read → write → read round-trip", () => {
		const roundTripped = readLaunch(writeLaunch(readLaunch(yaml)));
		expect(roundTripped.repository).toBe("https://github.com/example/my-app#main");
		expect(roundTripped.website).toBe("https://example.com");
		expect(roundTripped.logo).toBe("https://example.com/logo.png");
		expect(roundTripped.keywords).toEqual(["blog", "cms"]);
	});

	it("leaves metadata undefined when absent", () => {
		const launch = readLaunch("name: bare-app\nimage: x/y:1\n");
		expect(launch.repository).toBeUndefined();
		expect(launch.keywords).toBeUndefined();
	});
});
