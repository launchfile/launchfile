import { describe, expect, it, vi } from "vitest";
import {
	DECLARED_VOLUME_EXCEPTIONS,
	type DeclaredVolumeException,
} from "../compose-generator.js";
import {
	type BackingImageCase,
	backingImageCases,
	checkDeclaredVolumes,
	type DeclaredVolumes,
	declaredLinuxVolumes,
	describeFinding,
	RegistryReadError,
	withRetries,
} from "../declared-volume-gate.js";

const declaredMap = (
	entries: Record<string, string[]>,
): Map<string, DeclaredVolumes> =>
	new Map(
		Object.entries(entries).map(([image, paths]) => [
			image,
			{ digest: "sha256:x", paths },
		]),
	);

describe("backingImageCases", () => {
	const cases = backingImageCases();

	it("reads every factory and every image-swapping postgres extension from the generator", () => {
		const labels = cases.map((c) => c.label);
		expect(labels).toEqual(
			expect.arrayContaining([
				"postgres",
				"mongodb",
				"memcache",
				"kafka",
				"postgres (extensions: [vector])",
				"postgres (extensions: [postgis])",
			]),
		);
		expect(
			cases.find((c) => c.label === "postgres (extensions: [vector])")?.image,
		).toBe("pgvector/pgvector:pg16");
	});

	it("takes mount targets from the generated compose", () => {
		expect(cases.find((c) => c.label === "mongodb")).toEqual({
			label: "mongodb",
			image: "mongo:7",
			mounts: ["/data/db"],
		});
		expect(cases.find((c) => c.label === "memcache")?.mounts).toEqual([]);
	});

	it("keys every exception to an image some backing service runs", () => {
		const images = new Set(cases.map((c) => c.image));
		for (const image of Object.keys(DECLARED_VOLUME_EXCEPTIONS)) {
			expect(images).toContain(image);
		}
	});
});

describe("declaredLinuxVolumes", () => {
	it("reads a multi-platform config and ignores windows platforms", () => {
		const raw = {
			"linux/amd64": {
				config: { Volumes: { "/data/db": {}, "/data/configdb": {} } },
			},
			"linux/arm64": {
				config: { Volumes: { "/data/configdb": {}, "/data/db": {} } },
			},
			"windows/amd64": { config: { Volumes: { "C:\\data\\db": {} } } },
		};
		expect(declaredLinuxVolumes("mongo:7", raw)).toEqual([
			"/data/configdb",
			"/data/db",
		]);
	});

	it("reads a single-platform config", () => {
		const raw = {
			os: "linux",
			architecture: "amd64",
			config: { Volumes: { "/var/lib/x": {} } },
		};
		expect(declaredLinuxVolumes("x:1", raw)).toEqual(["/var/lib/x"]);
	});

	it("returns an empty set when the image declares no VOLUME", () => {
		expect(
			declaredLinuxVolumes("memcached:1-alpine", {
				"linux/amd64": { config: { Volumes: null } },
				"linux/arm64": { config: {} },
			}),
		).toEqual([]);
	});

	it("fails when linux platforms disagree", () => {
		expect(() =>
			declaredLinuxVolumes("x:1", {
				"linux/amd64": { config: { Volumes: { "/a": {} } } },
				"linux/arm64": { config: { Volumes: { "/b": {} } } },
			}),
		).toThrow(/linux platforms declare different VOLUME sets/);
	});

	it("fails when there is no linux platform or no config", () => {
		expect(() =>
			declaredLinuxVolumes("x:1", { "windows/amd64": { config: {} } }),
		).toThrow(/no linux platform/);
		expect(() => declaredLinuxVolumes("x:1", null)).toThrow(/not an object/);
	});
});

describe("checkDeclaredVolumes", () => {
	const cases: BackingImageCase[] = [
		{ label: "db", image: "db:1", mounts: ["/var/lib/db"] },
		{ label: "multi", image: "multi:1", mounts: ["/data/main"] },
		{ label: "cache", image: "cache:1", mounts: [] },
	];
	const exceptions: Record<string, DeclaredVolumeException> = {
		"multi:1": { kind: "unmounted", paths: ["/data/side"], reason: "r" },
		"cache:1": { kind: "declares-none", reason: "r" },
	};

	it("passes when every declared path is mounted or excepted", () => {
		const declared = declaredMap({
			"db:1": ["/var/lib/db"],
			"multi:1": ["/data/main", "/data/side"],
			"cache:1": [],
		});
		expect(checkDeclaredVolumes(cases, declared, exceptions)).toEqual([]);
	});

	it("reports a declared path the service does not mount", () => {
		const declared = declaredMap({
			"db:1": ["/var/lib/db-real"],
			"multi:1": ["/data/main", "/data/side"],
			"cache:1": [],
		});
		const findings = checkDeclaredVolumes(cases, declared, exceptions);
		expect(findings).toEqual([
			{
				kind: "unmounted",
				label: "db",
				image: "db:1",
				path: "/var/lib/db-real",
			},
		]);
		expect(findings.map(describeFinding)[0]).toMatch(
			/^declared VOLUME not mounted: db:1 declares \/var\/lib\/db-real/,
		);
	});

	it("does not accept a parent-directory mount as covering a declared path", () => {
		const declared = declaredMap({
			"db:1": ["/var/lib/db/data"],
			"multi:1": ["/data/main", "/data/side"],
			"cache:1": [],
		});
		expect(checkDeclaredVolumes(cases, declared, exceptions)).toHaveLength(1);
	});

	it("reports an image with an empty VOLUME set that is not listed", () => {
		const declared = declaredMap({
			"db:1": [],
			"multi:1": ["/data/main", "/data/side"],
			"cache:1": [],
		});
		expect(checkDeclaredVolumes(cases, declared, exceptions)).toEqual([
			{ kind: "unlisted-empty", label: "db", image: "db:1" },
		]);
	});

	it("reports exceptions that no longer match the image or the generator", () => {
		const declared = declaredMap({
			"db:1": ["/var/lib/db"],
			"multi:1": ["/data/main"],
			"cache:1": ["/cache"],
		});
		const withStale: Record<string, DeclaredVolumeException> = {
			...exceptions,
			"gone:1": { kind: "declares-none", reason: "r" },
			"db:1": { kind: "unmounted", paths: ["/var/lib/db"], reason: "r" },
		};
		const details = checkDeclaredVolumes(cases, declared, withStale)
			.filter((f) => f.kind === "stale-exception")
			.map(describeFinding);
		expect(details).toEqual(
			expect.arrayContaining([
				"stale DECLARED_VOLUME_EXCEPTIONS entry for gone:1: no backing service runs this image",
				"stale DECLARED_VOLUME_EXCEPTIONS entry for multi:1: excuses /data/side, which the image no longer declares",
				"stale DECLARED_VOLUME_EXCEPTIONS entry for cache:1: listed as declaring no VOLUME, but declares /cache",
				"stale DECLARED_VOLUME_EXCEPTIONS entry for db:1: excuses /var/lib/db, which db mounts",
			]),
		);
	});

	it("throws rather than passing an image it has no registry read for", () => {
		expect(() =>
			checkDeclaredVolumes(
				cases,
				declaredMap({ "db:1": ["/var/lib/db"] }),
				exceptions,
			),
		).toThrow(/no declared VOLUME read for multi:1/);
	});
});

describe("withRetries", () => {
	it("returns the first success after a flake", async () => {
		const sleep = vi.fn(async () => {});
		const read = vi
			.fn()
			.mockRejectedValueOnce(new Error("503"))
			.mockResolvedValueOnce("ok");
		await expect(withRetries("x:1", read, 3, sleep)).resolves.toBe("ok");
		expect(read).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(1);
	});

	it("fails loudly after the last attempt, naming the image and the attempt count", async () => {
		const sleep = vi.fn(async () => {});
		const read = vi.fn().mockRejectedValue(new Error("toomanyrequests"));
		const result = withRetries("minio/minio:latest", read, 3, sleep);
		await expect(result).rejects.toBeInstanceOf(RegistryReadError);
		await expect(result).rejects.toThrow(
			"could not read the registry for minio/minio:latest after 3 attempts: toomanyrequests",
		);
		expect(read).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
	});
});
