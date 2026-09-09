/**
 * The operator-supplied storage channel (D-50): matching supplied paths to
 * `content: operator` volumes, and the two refusals a provider raises when a
 * marked volume has no usable path.
 *
 * Every provider decides for itself which components it translates — one skips
 * a component declaring no image, another refuses one needing a host
 * capability — so this module indexes the supplied keys and answers per
 * volume rather than walking the launch itself. The caller keeps its own loop
 * and its own idea of which components are in play; only the key rule and the
 * refusal wording live here, once.
 */

import type { NormalizedLaunch } from "./types.js";

/** An operator-supplied path matched to a volume, with the key as it was typed. */
export interface SuppliedStoragePath {
	/** The supplied key, verbatim — echoed in refusals so the operator recognizes it. */
	key: string;
	path: string;
}

/** A `content: operator` volume bound to an operator-supplied host path (D-50 row 1). */
export interface StorageBind {
	component: string;
	volume: string;
	/** The supplied key that carried the path, as the operator wrote it. */
	key: string;
	hostPath: string;
	containerPath: string;
}

/** A `content: operator` volume no supplied path covers (D-50 row 2). */
export interface UnboundOperatorVolume {
	component: string;
	volume: string;
	/** The exact flag that satisfies the volume, e.g. `--storage music=<path>`. */
	flag: string;
}

/**
 * Pure lookups over one invocation's supplied storage paths. Built once per
 * launch, then asked per volume from inside the provider's own component loop.
 */
export interface OperatorStorageIndex {
	/**
	 * The supplied path covering a component's volume, or `undefined` when none
	 * does. A `component.volume` key wins over a bare `volume` key naming the
	 * same volume (D-50 rule 1).
	 */
	lookup(component: string, volume: string): SuppliedStoragePath | undefined;
	/**
	 * The flag that satisfies a volume, for the refusal message. Takes the
	 * `component.volume` spelling when more than one component declares a
	 * volume of that name, and the bare spelling otherwise.
	 */
	flagFor(component: string, volume: string): string;
	/**
	 * Supplied keys absent from `used` — the ones that bound nothing. The
	 * caller records a key as used when it accepts that key's `lookup` result,
	 * so a key naming an unmarked volume counts as unused too: D-50 row 4
	 * keeps unmarked volumes byte-identical, and a path aimed at one does
	 * nothing.
	 */
	unusedKeys(used: ReadonlySet<string>): string[];
}

/**
 * Index one invocation's supplied storage paths against a launch.
 *
 * The key rule is D-50 rule 1: split on the **first** dot; if the left half
 * names a component, the key is component-qualified, and otherwise the whole
 * string is a volume name, dots included. A leading-dot key has no left half
 * and is therefore a bare volume name.
 */
export function indexOperatorStoragePaths(
	launch: NormalizedLaunch,
	suppliedPaths: Readonly<Record<string, string>> | undefined,
): OperatorStorageIndex {
	const componentSet = new Set(Object.keys(launch.components));
	const qualified = new Map<string, SuppliedStoragePath>();
	const bare = new Map<string, SuppliedStoragePath>();
	for (const [key, path] of Object.entries(suppliedPaths ?? {})) {
		const dot = key.indexOf(".");
		if (dot > 0 && componentSet.has(key.slice(0, dot))) {
			qualified.set(key, { key, path });
		} else {
			bare.set(key, { key, path });
		}
	}

	// How many components declare a volume of each name — an ambiguous name gets
	// the `component.volume` spelling in the refusal's suggested flag.
	const volumeNameCount = new Map<string, number>();
	for (const comp of Object.values(launch.components)) {
		for (const volName of Object.keys(comp.storage ?? {})) {
			volumeNameCount.set(volName, (volumeNameCount.get(volName) ?? 0) + 1);
		}
	}

	return {
		lookup(component, volume) {
			return qualified.get(`${component}.${volume}`) ?? bare.get(volume);
		},
		flagFor(component, volume) {
			const spelling =
				(volumeNameCount.get(volume) ?? 0) > 1 ? `${component}.${volume}` : volume;
			return `--storage ${spelling}=<path>`;
		},
		unusedKeys(used) {
			return Object.keys(suppliedPaths ?? {}).filter((key) => !used.has(key));
		},
	};
}

/**
 * A deploy refused because a `content: operator` volume arrived with no host
 * path (D-50 rule 2, row 2). Creating the volume empty and starting anyway is
 * D-52's fabrication in storage form — the silent success this refusal closes.
 * Each line names the volume and the exact flag that satisfies it.
 */
export class UnboundOperatorStorageError extends Error {
	/** An operator-fixable precondition, not a crash — see `ExpectedRefusal`. */
	readonly expectedRefusal = true as const;
	readonly volumes: UnboundOperatorVolume[];

	constructor(volumes: UnboundOperatorVolume[]) {
		const lines = volumes.map(
			({ component, volume, flag }) => `  - ${component}: ${volume} — supply it with ${flag}`,
		);
		super(
			`Cannot launch: ${volumes.length} volume${volumes.length === 1 ? "" : "s"} marked ` +
				"`content: operator` had no host path.\n" +
				`${lines.join("\n")}\n` +
				"The Launchfile declares that you supply this content (D-50); this provider will not\n" +
				"create an empty volume in its place. Provide each path and run `up` again.",
		);
		this.name = "UnboundOperatorStorageError";
		this.volumes = volumes;
	}
}

/**
 * A deploy refused because an operator-supplied storage path is absent or
 * unreadable on the host (D-50 rule 2, row 3). The directory is never
 * created: a silently minted empty `~/Music` would reintroduce the
 * empty-library failure through this channel's own flag.
 */
export class MissingOperatorStoragePathError extends Error {
	/** An operator-fixable precondition, not a crash — see `ExpectedRefusal`. */
	readonly expectedRefusal = true as const;
	readonly binds: StorageBind[];

	constructor(binds: StorageBind[]) {
		const lines = binds.map(
			({ component, volume, key, hostPath }) =>
				`  - ${component}: ${volume} — --storage ${key}=${hostPath}`,
		);
		super(
			(binds.length === 1
				? "Cannot launch: a supplied storage path does not exist or is not readable."
				: `Cannot launch: ${binds.length} supplied storage paths do not exist or are not readable.`) +
				`\n${lines.join("\n")}\n` +
				"The volume is marked `content: operator` (D-50), so this provider refuses to create\n" +
				"the directory — an empty one here is the missing-content failure the marker exists\n" +
				"to catch. Check each path and run `up` again.",
		);
		this.name = "MissingOperatorStoragePathError";
		this.binds = binds;
	}
}
