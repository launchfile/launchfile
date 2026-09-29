import { describe, expect, it } from "vitest";
import { backfillMetadata, type SizeOf } from "./backfill-sizes.ts";

const tested = `category: Notifications
tagline: Simple HTTP-based pub-sub push notification service
homepage: https://ntfy.sh
test_results:
  last_tested: 2026-09-24
  pull_time_seconds: 2
  startup_time_seconds: 7
  total_disk_mb: 110
  health_check_passed: true
  notes: ""
images:
  - name: binwiederhier/ntfy:latest
    size_mb: 110
    platform:
      - linux/arm64
  - name: redis:7-alpine
    size_mb: 40
    platform:
      - linux/arm64
`;

const sizes: SizeOf = async (image) => ({ "binwiederhier/ntfy:latest": 33, "redis:7-alpine": 16 })[image] ?? 0;

describe("backfillMetadata", () => {
	it("rewrites size_mb and renames total_disk_mb in place, leaving every other line alone", async () => {
		const res = await backfillMetadata(tested, sizes);
		expect(res.changed).toBe(true);
		expect(res.skipped).toEqual([]);
		expect(res.failed).toEqual([]);
		expect(res.text).toBe(
			tested
				.replace("total_disk_mb: 110", "total_download_mb: 49")
				.replace("size_mb: 110", "size_mb: 33")
				.replace("size_mb: 40", "size_mb: 16"),
		);
	});

	it("keeps a hand-wrapped string and comments byte-identical", async () => {
		const wrapped = tested.replace(
			'  notes: ""\n',
			"  # measured on arm64\n  notes: A long note that a maintainer wrapped by hand at a width the YAML library would not choose,\n    so a re-serializer would reflow it.\n",
		);
		const res = await backfillMetadata(wrapped, sizes);
		expect(res.text).toBe(
			wrapped
				.replace("total_disk_mb: 110", "total_download_mb: 49")
				.replace("size_mb: 110", "size_mb: 33")
				.replace("size_mb: 40", "size_mb: 16"),
		);
	});

	it("is idempotent", async () => {
		const once = await backfillMetadata(tested, sizes);
		const twice = await backfillMetadata(once.text, sizes);
		expect(twice.changed).toBe(false);
		expect(twice.text).toBe(once.text);
	});

	it("passes the recorded platform to the lookup", async () => {
		const asked: string[] = [];
		await backfillMetadata(tested.replace("- linux/arm64\n  - name: redis", "- linux/arm/v7\n  - name: redis"), async (i, p) => {
			asked.push(`${i} ${p}`);
			return 1;
		});
		expect(asked).toEqual(["binwiederhier/ntfy:latest linux/arm/v7", "redis:7-alpine linux/arm64"]);
	});

	it("lists an unknown-platform image and keeps its size", async () => {
		const input = tested.replace("- linux/arm64\n  - name: redis", "- unknown\n  - name: redis");
		const res = await backfillMetadata(input, sizes);
		expect(res.skipped).toEqual(["binwiederhier/ntfy:latest (unknown)"]);
		expect(res.text).toContain("size_mb: 110");
		expect(res.text).toContain("total_download_mb: 126");
	});

	it("leaves the file unchanged when a lookup fails", async () => {
		const res = await backfillMetadata(tested, async (image) => {
			if (image.startsWith("redis")) throw new Error("registry unreachable");
			return 33;
		});
		expect(res.changed).toBe(false);
		expect(res.text).toBe(tested);
		expect(res.failed).toEqual(["redis:7-alpine: registry unreachable"]);
	});

	it("leaves a file with no images alone", async () => {
		const draft = 'category: Backend\ntagline: "Open-source backend"\n';
		const res = await backfillMetadata(draft, sizes);
		expect(res).toEqual({ text: draft, changed: false, skipped: [], failed: [] });
	});
});
