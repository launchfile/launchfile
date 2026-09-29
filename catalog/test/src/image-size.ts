/**
 * `images[].size_mb` in a catalog `metadata.yaml`: the compressed download
 * size of an image for one platform, read from the registry manifest.
 *
 * The figure is the sum of `layers[].size` in the platform's image manifest,
 * in MiB, rounded with `Math.round(bytes / 1024 / 1024)`. It does not read the
 * local Docker image store, so two machines measuring the same tag agree.
 */

/** Fetches one manifest (index or image manifest) as parsed JSON. */
export type FetchManifest = (ref: string) => Promise<unknown>;

export interface Platform {
	os: string;
	architecture: string;
	variant?: string;
}

export class ImageSizeError extends Error {
	override name = "ImageSizeError";
}

/**
 * containerd treats `arm64` and `arm64/v8` as the same platform, and registries
 * list both spellings. Drop the default variant so they compare equal.
 */
function normalize(p: Platform): Platform {
	if (p.architecture === "arm64" && p.variant === "v8") {
		return { os: p.os, architecture: p.architecture };
	}
	return p;
}

/** Parses the `os/arch[/variant]` string the harness records in `images[].platform`. */
export function parsePlatform(text: string): Platform {
	const parts = text.split("/");
	if (parts.length < 2 || parts.length > 3 || parts.some((p) => p.length === 0) || parts.includes("unknown")) {
		throw new ImageSizeError(`platform "${text}" is not os/arch[/variant]`);
	}
	const [os, architecture, variant] = parts as [string, string, string | undefined];
	return normalize(variant ? { os, architecture, variant } : { os, architecture });
}

/** Formats a platform as `os/arch[/variant]`, with `arm64/v8` written as `arm64`. */
export function formatPlatform(p: Platform): string {
	const n = normalize(p);
	return n.variant ? `${n.os}/${n.architecture}/${n.variant}` : `${n.os}/${n.architecture}`;
}

/** The image reference without its tag or digest: `ghcr.io/a/b:1@sha256:…` → `ghcr.io/a/b`. */
export function repositoryOf(image: string): string {
	const noDigest = image.split("@")[0]!;
	const lastSlash = noDigest.lastIndexOf("/");
	const lastColon = noDigest.lastIndexOf(":");
	return lastColon > lastSlash ? noDigest.slice(0, lastColon) : noDigest;
}

interface IndexEntry {
	digest: string;
	platform?: Partial<Platform>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function selectEntry(image: string, entries: unknown[], want: Platform): IndexEntry {
	const candidates = entries.filter((e): e is IndexEntry => {
		if (!isRecord(e) || typeof e.digest !== "string" || !isRecord(e.platform)) return false;
		const p = e.platform;
		if (typeof p.os !== "string" || typeof p.architecture !== "string") return false;
		const have = normalize({
			os: p.os,
			architecture: p.architecture,
			...(typeof p.variant === "string" ? { variant: p.variant } : {}),
		});
		if (have.os !== want.os || have.architecture !== want.architecture) return false;
		return want.variant === undefined || have.variant === want.variant;
	});
	if (candidates.length === 0) {
		throw new ImageSizeError(`${image}: the manifest index has no entry for ${formatPlatform(want)}`);
	}
	if (candidates.length > 1) {
		const variants = candidates.map((c) => c.platform?.variant ?? "(none)").join(", ");
		throw new ImageSizeError(
			`${image}: ${formatPlatform(want)} matches ${candidates.length} index entries (variants: ${variants}); record the variant`,
		);
	}
	return candidates[0]!;
}

function sumLayers(image: string, manifest: Record<string, unknown>): number {
	const layers = manifest.layers;
	if (!Array.isArray(layers)) {
		throw new ImageSizeError(`${image}: the manifest has no layers[] (unsupported manifest format)`);
	}
	let total = 0;
	for (const layer of layers) {
		if (!isRecord(layer) || typeof layer.size !== "number" || !Number.isFinite(layer.size) || layer.size < 0) {
			throw new ImageSizeError(`${image}: a manifest layer has no numeric size`);
		}
		total += layer.size;
	}
	return total;
}

/**
 * Compressed download bytes of `image` for `platform`. An image with a
 * manifest index resolves to the index entry for that platform. An image with
 * one manifest and no index uses that manifest.
 */
export async function downloadBytes(image: string, platform: string, fetchManifest: FetchManifest): Promise<number> {
	const want = parsePlatform(platform);
	const repository = repositoryOf(image);
	let ref = image;
	// An index entry can point at a nested index; two levels covers every
	// layout registries publish.
	for (let depth = 0; depth < 3; depth++) {
		const doc = await fetchManifest(ref);
		if (!isRecord(doc)) {
			throw new ImageSizeError(`${image}: the manifest for ${ref} is not a JSON object`);
		}
		if (Array.isArray(doc.manifests)) {
			ref = `${repository}@${selectEntry(image, doc.manifests, want).digest}`;
			continue;
		}
		return sumLayers(image, doc);
	}
	throw new ImageSizeError(`${image}: manifest indexes nest deeper than 3 levels`);
}

export function bytesToMiB(bytes: number): number {
	return Math.round(bytes / 1024 / 1024);
}

/** `images[].size_mb` for `image` on `platform`. */
export async function downloadSizeMb(image: string, platform: string, fetchManifest: FetchManifest): Promise<number> {
	return bytesToMiB(await downloadBytes(image, platform, fetchManifest));
}

/** A command runner with the harness's `run([...])` shape: argv array, never a shell string. */
export type RunCommand = (cmd: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** Reads manifests through `docker manifest inspect`, which queries the registry, not the local image store. */
export function dockerManifestFetcher(run: RunCommand): FetchManifest {
	return async (ref) => {
		const res = await run(["docker", "manifest", "inspect", ref]);
		if (res.exitCode !== 0) {
			throw new ImageSizeError(`docker manifest inspect ${ref} exited ${res.exitCode}: ${res.stderr.trim()}`);
		}
		try {
			return JSON.parse(res.stdout) as unknown;
		} catch {
			throw new ImageSizeError(`docker manifest inspect ${ref} printed invalid JSON`);
		}
	};
}
