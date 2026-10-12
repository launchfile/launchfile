import { describe, expect, it } from "vitest";
import {
	bytesToMiB,
	dockerManifestFetcher,
	downloadBytes,
	downloadSizeMb,
	type FetchManifest,
	formatPlatform,
	ImageSizeError,
	parsePlatform,
	repositoryOf,
} from "./image-size.ts";

const MiB = 1024 * 1024;

function manifest(...sizes: number[]) {
	return {
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		config: { size: 3000, digest: "sha256:cfg" },
		layers: sizes.map((size, i) => ({ size, digest: `sha256:l${i}` })),
	};
}

function index(entries: Array<{ digest: string; architecture: string; os?: string; variant?: string }>) {
	return {
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.index.v1+json",
		manifests: entries.map(({ digest, architecture, os = "linux", variant }) => ({
			digest,
			platform: { os, architecture, ...(variant ? { variant } : {}) },
		})),
	};
}

/** A registry stub keyed by reference; records every reference it was asked for. */
function registry(docs: Record<string, unknown>): FetchManifest & { asked: string[] } {
	const asked: string[] = [];
	const fetch = async (ref: string) => {
		asked.push(ref);
		if (!(ref in docs)) throw new ImageSizeError(`no manifest for ${ref}`);
		return docs[ref];
	};
	return Object.assign(fetch, { asked });
}

describe("parsePlatform / formatPlatform", () => {
	it("reads os/arch and os/arch/variant", () => {
		expect(parsePlatform("linux/amd64")).toEqual({ os: "linux", architecture: "amd64" });
		expect(parsePlatform("linux/arm/v7")).toEqual({ os: "linux", architecture: "arm", variant: "v7" });
	});

	it("treats arm64/v8 as arm64", () => {
		expect(parsePlatform("linux/arm64/v8")).toEqual({ os: "linux", architecture: "arm64" });
		expect(formatPlatform({ os: "linux", architecture: "arm64", variant: "v8" })).toBe("linux/arm64");
		expect(formatPlatform({ os: "linux", architecture: "arm", variant: "v7" })).toBe("linux/arm/v7");
	});

	it("rejects unknown and malformed platforms", () => {
		expect(() => parsePlatform("unknown")).toThrow(ImageSizeError);
		expect(() => parsePlatform("linux/unknown")).toThrow(ImageSizeError);
		expect(() => parsePlatform("linux")).toThrow(ImageSizeError);
		expect(() => parsePlatform("linux//v7")).toThrow(ImageSizeError);
	});
});

describe("repositoryOf", () => {
	it("drops the tag and the digest, keeping a registry port", () => {
		expect(repositoryOf("redis:7-alpine")).toBe("redis");
		expect(repositoryOf("ghcr.io/org/app:1.2@sha256:abc")).toBe("ghcr.io/org/app");
		expect(repositoryOf("localhost:5000/app")).toBe("localhost:5000/app");
		expect(repositoryOf("localhost:5000/app:3")).toBe("localhost:5000/app");
	});
});

describe("downloadBytes", () => {
	it("sums the layers of the index entry for the recorded platform", async () => {
		const fetch = registry({
			"binwiederhier/ntfy:latest": index([
				{ digest: "sha256:amd", architecture: "amd64" },
				{ digest: "sha256:arm", architecture: "arm64" },
			]),
			"binwiederhier/ntfy@sha256:amd": manifest(50 * MiB),
			"binwiederhier/ntfy@sha256:arm": manifest(4_183_037, 30_480_905),
		});
		expect(await downloadBytes("binwiederhier/ntfy:latest", "linux/arm64", fetch)).toBe(34_663_942);
		expect(fetch.asked).toEqual(["binwiederhier/ntfy:latest", "binwiederhier/ntfy@sha256:arm"]);
	});

	it("counts layers only, not the config blob", async () => {
		const fetch = registry({ "app:1": manifest(MiB) });
		expect(await downloadBytes("app:1", "linux/amd64", fetch)).toBe(MiB);
	});

	it("uses the one manifest of a single-platform image with no index", async () => {
		const fetch = registry({ "app:1": manifest(2 * MiB, 3 * MiB) });
		expect(await downloadSizeMb("app:1", "linux/arm64", fetch)).toBe(5);
	});

	it("matches arm64 against an index entry spelled arm64/v8", async () => {
		const fetch = registry({
			"postgres:16-alpine": index([
				{ digest: "sha256:unk", architecture: "unknown", os: "unknown" },
				{ digest: "sha256:a64", architecture: "arm64", variant: "v8" },
			]),
			"postgres@sha256:a64": manifest(7 * MiB),
		});
		expect(await downloadSizeMb("postgres:16-alpine", "linux/arm64", fetch)).toBe(7);
	});

	it("matches the variant when the platform records one", async () => {
		const fetch = registry({
			"app:1": index([
				{ digest: "sha256:v6", architecture: "arm", variant: "v6" },
				{ digest: "sha256:v7", architecture: "arm", variant: "v7" },
			]),
			"app@sha256:v6": manifest(MiB),
			"app@sha256:v7": manifest(9 * MiB),
		});
		expect(await downloadSizeMb("app:1", "linux/arm/v7", fetch)).toBe(9);
	});

	it("refuses to guess between variants when the platform records none", async () => {
		const fetch = registry({
			"app:1": index([
				{ digest: "sha256:v6", architecture: "arm", variant: "v6" },
				{ digest: "sha256:v7", architecture: "arm", variant: "v7" },
			]),
		});
		await expect(downloadBytes("app:1", "linux/arm", fetch)).rejects.toThrow(/matches 2 index entries/);
	});

	it("follows a nested index", async () => {
		const fetch = registry({
			"app:1": index([{ digest: "sha256:inner", architecture: "amd64" }]),
			"app@sha256:inner": index([{ digest: "sha256:m", architecture: "amd64" }]),
			"app@sha256:m": manifest(MiB),
		});
		expect(await downloadBytes("app:1", "linux/amd64", fetch)).toBe(MiB);
	});

	it("fails when the index has no entry for the platform", async () => {
		const fetch = registry({ "app:1": index([{ digest: "sha256:amd", architecture: "amd64" }]) });
		await expect(downloadBytes("app:1", "linux/arm64", fetch)).rejects.toThrow(/no entry for linux\/arm64/);
	});

	it("fails when the lookup fails, with no fallback", async () => {
		await expect(downloadBytes("gone:1", "linux/amd64", registry({}))).rejects.toThrow(/no manifest for gone:1/);
	});

	it("fails on a manifest without layer sizes", async () => {
		const fetch = registry({ "old:1": { schemaVersion: 1, fsLayers: [{ blobSum: "sha256:x" }] } });
		await expect(downloadBytes("old:1", "linux/amd64", fetch)).rejects.toThrow(/no layers\[\]/);
		const bad = registry({ "bad:1": { layers: [{ digest: "sha256:x" }] } });
		await expect(downloadBytes("bad:1", "linux/amd64", bad)).rejects.toThrow(/no numeric size/);
	});

	it("fails on an unknown platform before any lookup", async () => {
		const fetch = registry({});
		await expect(downloadBytes("app:1", "unknown", fetch)).rejects.toThrow(ImageSizeError);
		expect(fetch.asked).toEqual([]);
	});
});

describe("bytesToMiB", () => {
	it("rounds to the nearest MiB", () => {
		expect(bytesToMiB(34_663_942)).toBe(33);
		expect(bytesToMiB(1.5 * MiB)).toBe(2);
		expect(bytesToMiB(0)).toBe(0);
	});
});

describe("dockerManifestFetcher", () => {
	it("runs docker manifest inspect with an argv array and parses the JSON", async () => {
		const calls: string[][] = [];
		const fetch = dockerManifestFetcher(async (cmd) => {
			calls.push(cmd);
			return { stdout: JSON.stringify(manifest(MiB)), stderr: "", exitCode: 0 };
		});
		expect(await fetch("app:1; rm x")).toEqual(manifest(MiB));
		expect(calls).toEqual([["docker", "manifest", "inspect", "app:1; rm x"]]);
	});

	it("throws with the exit code and stderr when docker fails", async () => {
		const fetch = dockerManifestFetcher(async () => ({ stdout: "", stderr: "no such manifest\n", exitCode: 1 }));
		await expect(fetch("app:1")).rejects.toThrow("docker manifest inspect app:1 exited 1: no such manifest");
	});

	it("throws on output that is not JSON", async () => {
		const fetch = dockerManifestFetcher(async () => ({ stdout: "oops", stderr: "", exitCode: 0 }));
		await expect(fetch("app:1")).rejects.toThrow(/invalid JSON/);
	});
});
