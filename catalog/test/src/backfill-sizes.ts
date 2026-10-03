#!/usr/bin/env bun
/**
 * Rewrites `images[].size_mb` and `test_results.total_download_mb` in every
 * catalog/apps/<app>/metadata.yaml and catalog/drafts/<app>/metadata.yaml from
 * registry manifests (see image-size.ts). It starts no container and leaves
 * every other field as it is, except that `test_results.total_disk_mb` is
 * renamed to `total_download_mb` in place.
 *
 * An image whose recorded platform is `unknown` keeps its `size_mb`; the
 * summary lists it for a harness rerun. Its file keeps the recorded total value,
 * because a sum of old and new sizes would mix two measures. A file with a
 * failed manifest lookup is not written, and the run exits 1.
 *
 * Usage: bun run backfill-sizes [app ...]
 *
 * Naming apps limits the run to those directories. Docker Hub rate-limits
 * manifest reads, so a rerun can target only the files a previous run left.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { dockerManifestFetcher, downloadSizeMb, type RunCommand } from "./image-size.ts";

/** Resolves `images[].size_mb` for one image on one recorded platform. */
export type SizeOf = (image: string, platform: string) => Promise<number>;

export interface BackfillResult {
	text: string;
	changed: boolean;
	/** `<image> (<platform>)` entries left for a harness rerun. */
	skipped: string[];
	/** `<image>: <reason>` entries whose lookup failed; `text` is the input when non-empty. */
	failed: string[];
}

function recordedPlatform(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0];
	return undefined;
}

interface Edit {
	start: number;
	end: number;
	text: string;
}

/**
 * Edits the source text at the parsed nodes' ranges instead of re-serializing
 * the document, so hand-wrapped strings and comments stay byte-identical.
 */
export async function backfillMetadata(text: string, sizeOf: SizeOf): Promise<BackfillResult> {
	const doc = parseDocument(text);
	const images = doc.get("images");
	if (!isSeq(images)) return { text, changed: false, skipped: [], failed: [] };

	const edits: Edit[] = [];
	const skipped: string[] = [];
	const failed: string[] = [];
	let total = 0;
	for (const item of images.items) {
		if (!isMap(item)) continue;
		const name = item.get("name");
		if (typeof name !== "string") continue;
		const platformNode = item.get("platform");
		const platform = recordedPlatform(isSeq(platformNode) ? platformNode.toJSON() : platformNode);
		const sizeNode = item.get("size_mb", true);
		if (!isScalar(sizeNode) || !sizeNode.range) {
			skipped.push(`${name} (no size_mb recorded)`);
			continue;
		}
		if (platform === undefined || platform === "unknown") {
			skipped.push(`${name} (${platform ?? "no single platform"})`);
			continue;
		}
		try {
			const sizeMb = await sizeOf(name, platform);
			edits.push({ start: sizeNode.range[0], end: sizeNode.range[1], text: String(sizeMb) });
			total += sizeMb;
		} catch (err) {
			failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (failed.length > 0) return { text, changed: false, skipped, failed };

	const results = doc.get("test_results");
	if (isMap(results)) {
		const pair = results.items.find(
			(p) => isScalar(p.key) && (p.key.value === "total_disk_mb" || p.key.value === "total_download_mb"),
		);
		if (pair && isScalar(pair.key) && pair.key.range && isScalar(pair.value) && pair.value.range) {
			edits.push({ start: pair.key.range[0], end: pair.key.range[1], text: "total_download_mb" });
			if (skipped.length === 0) {
				edits.push({ start: pair.value.range[0], end: pair.value.range[1], text: String(total) });
			}
		}
	}

	let out = text;
	for (const e of edits.sort((a, b) => b.start - a.start)) {
		out = out.slice(0, e.start) + e.text + out.slice(e.end);
	}
	return { text: out, changed: out !== text, skipped, failed };
}

/** Every metadata.yaml under catalog/apps and catalog/drafts, sorted. */
export function metadataPaths(catalogRoot: string): string[] {
	const paths: string[] = [];
	for (const dir of ["apps", "drafts"]) {
		const base = resolve(catalogRoot, dir);
		if (!existsSync(base)) continue;
		for (const app of readdirSync(base).sort()) {
			const path = resolve(base, app, "metadata.yaml");
			if (existsSync(path)) paths.push(path);
		}
	}
	return paths;
}

if (import.meta.main) {
	const catalogRoot = resolve(import.meta.dir, "..", "..");
	const run: RunCommand = async (cmd) => {
		const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => proc.kill(), 60_000);
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;
		clearTimeout(timer);
		return { stdout, stderr, exitCode };
	};
	const fetchManifest = dockerManifestFetcher(run);
	const cache = new Map<string, Promise<number>>();
	const sizeOf: SizeOf = (image, platform) => {
		const key = `${image} ${platform}`;
		let size = cache.get(key);
		if (!size) {
			size = downloadSizeMb(image, platform, fetchManifest);
			cache.set(key, size);
		}
		return size;
	};

	const changed: string[] = [];
	const skipped: string[] = [];
	const failed: string[] = [];
	const only = new Set(process.argv.slice(2));
	const paths = metadataPaths(catalogRoot).filter((p) => only.size === 0 || only.has(basename(dirname(p))));
	for (const path of paths) {
		const rel = path.slice(catalogRoot.length + 1);
		const res = await backfillMetadata(readFileSync(path, "utf-8"), sizeOf);
		skipped.push(...res.skipped.map((s) => `${rel}: ${s}`));
		failed.push(...res.failed.map((f) => `${rel}: ${f}`));
		if (res.changed) {
			writeFileSync(path, res.text);
			changed.push(rel);
		}
	}

	process.stdout.write(`Scanned ${paths.length} metadata.yaml files, ${cache.size} distinct image/platform pairs.\n`);
	process.stdout.write(`Files changed: ${changed.length}\n`);
	for (const c of changed) process.stdout.write(`  ${c}\n`);
	process.stdout.write(`Images skipped (platform unknown, rerun the harness): ${skipped.length}\n`);
	for (const s of skipped) process.stdout.write(`  ${s}\n`);
	if (failed.length > 0) {
		process.stdout.write(`Lookups failed (file left unchanged): ${failed.length}\n`);
		for (const f of failed) process.stdout.write(`  ${f}\n`);
		process.exit(1);
	}
}
