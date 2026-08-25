/**
 * State management for the Docker provider.
 *
 * State lives at ~/.launchfile/docker/{slug}/ so apps are
 * isolated and state persists across runs.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { registerSecrets } from "./redact.js";

/** Where the Launchfile that produced this state came from. */
export type DockerSourceType = "local" | "catalog" | "url";

/**
 * A published endpoint's metadata, keyed by the same key as its entry in
 * `DockerState.ports`. Carries what the ports map alone cannot: which
 * component the key belongs to, the endpoint's declared name (D-6), and its
 * protocol — so summary/status/list can print a protocol-correct address and
 * filter by component.
 */
export interface StateEndpoint {
	component: string;
	name?: string;
	containerPort: number;
	hostPort: number;
	protocol?: string;
}

export interface DockerState {
	version: 1;
	slug: string;
	appName: string;
	composeProject: string;
	launchfileHash: string;
	createdAt: string;
	updatedAt: string;
	secrets: Record<string, string>;
	ports: Record<string, number>;
	/**
	 * Minted `env:`-level generator values (D-49: generate once, then
	 * preserve), keyed `<component>.<ENV_NAME>` — one entry per declaration
	 * (D-25), so same-named variables on different components hold independent
	 * values. `generator: port` values are never stored here (ports are
	 * re-allocated each run). Kept disjoint from `secrets`, which is already a
	 * shared namespace of declared secret names and backing-service password
	 * keys — env-var names must not join it or become resolvable as
	 * `$secrets.<name>`. Optional for backward compatibility: older state
	 * files omit it and load as a first run.
	 */
	generatedEnv?: Record<string, string>;
	/**
	 * Endpoint metadata for each `ports` key. Optional for backward
	 * compatibility — state files written by older versions lack it, and
	 * consumers must fall back to the ports map alone.
	 */
	endpoints?: Record<string, StateEndpoint>;
	/**
	 * Where the Launchfile came from, persisted so post-launch operations
	 * (bootstrap, inspect) can re-read it without depending on the caller's
	 * cwd (#25). Optional for backward compatibility — state files written by
	 * older versions lack these fields and must still load.
	 */
	sourceType?: DockerSourceType;
	/**
	 * Absolute path to the Launchfile on disk for `local` sources. Undefined
	 * for catalog/url sources (re-resolve from `slug`/`sourceUrl` instead).
	 */
	sourcePath?: string;
	/** Original URL for `url` sources, so it can be re-fetched. */
	sourceUrl?: string;
}

export function stateBaseDir(): string {
	return join(homedir(), ".launchfile", "docker");
}

export function stateDir(slug: string): string {
	return join(stateBaseDir(), slug);
}

function statePath(slug: string): string {
	return join(stateDir(slug), "state.json");
}

export function composePath(slug: string): string {
	return join(stateDir(slug), "docker-compose.yml");
}

const SAFE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SLUG_LENGTH = 63;

function normalizeSlugForProject(slug: string): string {
	const normalized = slug.trim().toLowerCase();
	if (!normalized || normalized.length > MAX_SLUG_LENGTH || !SAFE_SLUG_PATTERN.test(normalized)) {
		throw new Error(
			`Invalid slug "${slug}". Expected lowercase letters/digits/hyphens, max ${MAX_SLUG_LENGTH} chars.`,
		);
	}
	return normalized;
}

export function composeProject(slug: string): string {
	return `launchfile-${normalizeSlugForProject(slug)}`;
}

/**
 * An instance label that cannot become part of a slug (D-55). An operator
 * mistake with an actionable message — labels are rejected, never silently
 * mangled, because a mangled label would key state under a name the operator
 * never typed.
 */
export class InvalidInstanceLabelError extends Error {
	/** An operator-fixable precondition, not a crash — see `ExpectedRefusal`. */
	readonly expectedRefusal = true as const;

	constructor(message: string) {
		super(message);
		this.name = "InvalidInstanceLabelError";
	}
}

/**
 * The slug a deployment's provider state is keyed by (D-55): the app's base
 * slug, qualified by the instance label when one is given. Everything that
 * keys off the slug — state dir, compose project (and through it volumes and
 * networks), port persistence — follows the label automatically, which is
 * what isolates two instances of one app.
 *
 * The label must already satisfy the slug rules (`SAFE_SLUG_PATTERN`) and the
 * combined slug must fit the compose project-name limit; violations are
 * rejected with the reason, never normalized away.
 */
export function instanceSlug(baseSlug: string, label?: string): string {
	if (!label) return baseSlug;
	if (!SAFE_SLUG_PATTERN.test(label)) {
		throw new InvalidInstanceLabelError(
			`Invalid instance name "${label}". Use lowercase letters, digits, and hyphens, starting with a letter or digit.`,
		);
	}
	const slug = `${baseSlug}-${label}`;
	if (slug.length > MAX_SLUG_LENGTH) {
		throw new InvalidInstanceLabelError(
			`Instance name "${label}" makes the combined slug "${slug}" longer than ${MAX_SLUG_LENGTH} characters. Use a shorter name.`,
		);
	}
	return slug;
}

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export async function loadState(slug: string): Promise<DockerState | null> {
	try {
		const raw = await readFile(statePath(slug), "utf8");
		const state = JSON.parse(raw) as DockerState;
		// Persisted secrets are reused across runs, so a value generated in an
		// earlier process still has to be scrubbable in this one (D-18).
		registerSecrets(Object.values(state.secrets ?? {}));
		registerSecrets(Object.values(state.generatedEnv ?? {}));
		return state;
	} catch {
		return null;
	}
}

export interface InitStateSource {
	sourceType?: DockerSourceType;
	sourcePath?: string;
	sourceUrl?: string;
}

export function initState(
	slug: string,
	appName: string,
	launchfileContent: string,
	source: InitStateSource = {},
): DockerState {
	const now = new Date().toISOString();
	return {
		version: 1,
		slug,
		appName,
		composeProject: composeProject(slug),
		launchfileHash: hashContent(launchfileContent),
		createdAt: now,
		updatedAt: now,
		secrets: {},
		ports: {},
		sourceType: source.sourceType,
		sourcePath: source.sourcePath,
		sourceUrl: source.sourceUrl,
	};
}

export async function saveState(slug: string, state: DockerState): Promise<void> {
	state.updatedAt = new Date().toISOString();
	// Security: restrict directory/file permissions — state.json contains
	// database passwords and generated secrets in plaintext.
	await mkdir(stateDir(slug), { recursive: true, mode: 0o700 });
	await writeFile(statePath(slug), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export async function ensureStateDir(slug: string): Promise<void> {
	await mkdir(stateDir(slug), { recursive: true, mode: 0o700 });
}

/** Persisted source location for a deployed slug (#25). */
export interface DockerSourceInfo {
	slug: string;
	sourceType?: DockerSourceType;
	sourcePath?: string;
	sourceUrl?: string;
}

/**
 * Read the persisted source location for a slug so post-launch operations
 * (bootstrap, inspect) can re-resolve the Launchfile without depending on the
 * caller's cwd. Returns null when no state exists. Fields may be undefined for
 * state files written before source persistence landed — callers must fall
 * back gracefully (#25).
 */
export async function loadDockerSource(slug: string): Promise<DockerSourceInfo | null> {
	const state = await loadState(slug);
	if (!state) return null;
	return {
		slug: state.slug,
		sourceType: state.sourceType,
		sourcePath: state.sourcePath,
		sourceUrl: state.sourceUrl,
	};
}
