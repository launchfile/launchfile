/**
 * Declared-VOLUME gate: every path a backing-service image declares as a
 * VOLUME must be mounted by the compose this provider generates, or be listed
 * in DECLARED_VOLUME_EXCEPTIONS with a reason. An image that declares no
 * VOLUME must be listed there too, so it cannot pass by having nothing to
 * check.
 *
 * Scope: this closes "the image declares a path the provider does not
 * mount". It cannot close "the image persists under a path it never
 * declares" — elasticsearch:8.17.0 is that case today. The image config is
 * the only independent source the gate reads, and an undeclared path is not
 * in it.
 *
 * This module is pure. src/check-declared-volumes.ts supplies the registry
 * reads and runs it in CI.
 */

import { readLaunch } from "@launchfile/sdk";
import { parse } from "yaml";
import {
	DECLARED_VOLUME_EXCEPTIONS,
	type DeclaredVolumeException,
	launchToCompose,
	POSTGRES_EXTENSION_IMAGES,
	resourcePropertyKeys,
} from "./compose-generator.js";

/** One backing service as the generator emits it. */
export interface BackingImageCase {
	/** What produced it: the resource type, plus any config that swaps the image. */
	label: string;
	image: string;
	/** Container paths the generated compose mounts a volume at. */
	mounts: string[];
}

/** What the registry says about one image. */
export interface DeclaredVolumes {
	digest: string;
	paths: string[];
}

export type GateFinding =
	| { kind: "unmounted"; label: string; image: string; path: string }
	| { kind: "unlisted-empty"; label: string; image: string }
	| { kind: "stale-exception"; image: string; detail: string };

interface ComposeDoc {
	services: Record<string, { image?: string; volumes?: string[] }>;
}

function caseFor(
	label: string,
	type: string,
	config?: Record<string, unknown>,
): BackingImageCase {
	const launch = readLaunch(
		JSON.stringify({
			name: "probe",
			image: "probe/app:1",
			provides: [{ protocol: "http", port: 3000 }],
			requires: [config ? { type, config } : { type }],
		}),
	);
	const doc = parse(launchToCompose(launch).yaml) as ComposeDoc;
	const service = doc.services[`probe-${type}`];
	if (!service?.image) {
		throw new Error(
			`generated compose has no probe-${type} service with an image`,
		);
	}
	const mounts = (service.volumes ?? []).map((v) =>
		v.slice(v.indexOf(":") + 1),
	);
	return { label, image: service.image, mounts };
}

/**
 * Every image a backing service can run, with the mounts the generator gives
 * it: one case per factory, plus one per postgres extension that swaps the
 * image. Read from the generator, never from a hand-written table.
 */
export function backingImageCases(): BackingImageCase[] {
	const cases = Object.keys(resourcePropertyKeys()).map((type) =>
		caseFor(type, type),
	);
	for (const ext of Object.keys(POSTGRES_EXTENSION_IMAGES)) {
		cases.push(
			caseFor(`postgres (extensions: [${ext}])`, "postgres", {
				extensions: [ext],
			}),
		);
	}
	return cases;
}

interface ImageConfig {
	os?: string;
	config?: { Volumes?: Record<string, unknown> | null } | null;
}

/**
 * The declared VOLUME paths from `docker buildx imagetools inspect --format
 * '{{json .Image}}'`. A multi-platform image comes back as a map of platform
 * to config; a single-platform one as the config itself. Only linux platforms
 * count (mongo also ships windows images with `C:\` paths), and they must
 * agree — the provider emits one mount for every platform.
 */
export function declaredLinuxVolumes(image: string, raw: unknown): string[] {
	if (raw === null || typeof raw !== "object") {
		throw new Error(`${image}: image config is not an object`);
	}
	const single = raw as ImageConfig;
	const platforms: [string, ImageConfig][] =
		"config" in single || "os" in single
			? [[single.os ?? "unknown", single]]
			: Object.entries(raw as Record<string, ImageConfig>);

	const sets = new Map<string, string>();
	for (const [platform, cfg] of platforms) {
		const os = platform.includes("/") ? platform.split("/")[0] : cfg?.os;
		if (os !== "linux") continue;
		const paths = Object.keys(cfg?.config?.Volumes ?? {}).sort();
		sets.set(platform, JSON.stringify(paths));
	}
	if (sets.size === 0) {
		throw new Error(`${image}: no linux platform in the image config`);
	}
	const distinct = new Set(sets.values());
	if (distinct.size > 1) {
		const detail = [...sets].map(([p, v]) => `${p}=${v}`).join(", ");
		throw new Error(
			`${image}: linux platforms declare different VOLUME sets (${detail})`,
		);
	}
	const [only = "[]"] = distinct;
	return JSON.parse(only) as string[];
}

/**
 * Compare each case's mounts against its image's declared VOLUME set, and
 * each exception against what the image declares today.
 */
export function checkDeclaredVolumes(
	cases: readonly BackingImageCase[],
	declared: ReadonlyMap<string, DeclaredVolumes>,
	exceptions: Readonly<
		Record<string, DeclaredVolumeException>
	> = DECLARED_VOLUME_EXCEPTIONS,
): GateFinding[] {
	const findings: GateFinding[] = [];

	for (const c of cases) {
		const paths = declared.get(c.image)?.paths;
		if (!paths) throw new Error(`no declared VOLUME read for ${c.image}`);
		const exception = exceptions[c.image];

		if (paths.length === 0) {
			if (exception?.kind !== "declares-none") {
				findings.push({
					kind: "unlisted-empty",
					label: c.label,
					image: c.image,
				});
			}
			continue;
		}
		const excused = exception?.kind === "unmounted" ? exception.paths : [];
		for (const path of paths) {
			if (!c.mounts.includes(path) && !excused.includes(path)) {
				findings.push({
					kind: "unmounted",
					label: c.label,
					image: c.image,
					path,
				});
			}
		}
	}

	const images = new Set(cases.map((c) => c.image));
	for (const [image, exception] of Object.entries(exceptions)) {
		if (!images.has(image)) {
			findings.push({
				kind: "stale-exception",
				image,
				detail: "no backing service runs this image",
			});
			continue;
		}
		const paths = declared.get(image)?.paths ?? [];
		if (exception.kind === "declares-none") {
			if (paths.length > 0) {
				findings.push({
					kind: "stale-exception",
					image,
					detail: `listed as declaring no VOLUME, but declares ${paths.join(", ")}`,
				});
			}
			continue;
		}
		for (const path of exception.paths) {
			if (!paths.includes(path)) {
				findings.push({
					kind: "stale-exception",
					image,
					detail: `excuses ${path}, which the image no longer declares`,
				});
			}
			for (const c of cases) {
				if (c.image === image && c.mounts.includes(path)) {
					findings.push({
						kind: "stale-exception",
						image,
						detail: `excuses ${path}, which ${c.label} mounts`,
					});
				}
			}
		}
	}
	return findings;
}

export function describeFinding(f: GateFinding): string {
	switch (f.kind) {
		case "unmounted":
			return (
				`declared VOLUME not mounted: ${f.image} declares ${f.path}, and the ${f.label} ` +
				"service mounts nothing there. Mount it, or add it to DECLARED_VOLUME_EXCEPTIONS " +
				"with the reason it is safe to leave on an anonymous volume."
			);
		case "unlisted-empty":
			return (
				`declared VOLUME set is empty: ${f.image} (${f.label}) declares no VOLUME, so this ` +
				"gate cannot check its mount. Add it to DECLARED_VOLUME_EXCEPTIONS as `declares-none` " +
				"with where it keeps its state."
			);
		case "stale-exception":
			return `stale DECLARED_VOLUME_EXCEPTIONS entry for ${f.image}: ${f.detail}`;
	}
}

export class RegistryReadError extends Error {
	constructor(
		readonly image: string,
		readonly attempts: number,
		readonly lastError: string,
	) {
		super(
			`could not read the registry for ${image} after ${attempts} attempts: ${lastError}`,
		);
		this.name = "RegistryReadError";
	}
}

/**
 * Call `read` until it succeeds or `attempts` runs out. A failure after the
 * last attempt throws RegistryReadError; it never returns an empty result.
 */
export async function withRetries<T>(
	image: string,
	read: () => Promise<T>,
	attempts: number,
	sleep: (ms: number) => Promise<void>,
	backoffMs = 2000,
): Promise<T> {
	let last = "";
	for (let i = 1; i <= attempts; i++) {
		try {
			return await read();
		} catch (err) {
			last = err instanceof Error ? err.message : String(err);
			if (i < attempts) await sleep(backoffMs * i);
		}
	}
	throw new RegistryReadError(image, attempts, last);
}
