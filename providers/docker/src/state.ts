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
import { getLogger } from "./logger.js";

/** Where the Launchfile that produced this state came from. */
export type DockerSourceType = "local" | "catalog" | "url";

/**
 * A published endpoint's metadata, keyed by the same key as its entry in
 * `DockerState.ports`. Carries what the ports map alone cannot: which
 * component the key belongs to, the endpoint's declared name (D-6), and its
 * EFFECTIVE protocol (D-61 rule 2) — the declared `protocol:` unless a bound
 * certificate is active, in which case `https`. Writers persist the effective
 * value: `status`, `up`, and `$app.url` all derive their address from it
 * through `publishedAddress`, so persisting the declared value here splits
 * them apart again (#473).
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
	/**
	 * Hash of the Launchfile text that produced the current deployment. `up`
	 * recompares it and warns on a mismatch (see `provider.ts` `dockerUp`),
	 * which is how an in-place edit of the same file becomes visible.
	 */
	launchfileHash: string;
	createdAt: string;
	updatedAt: string;
	/**
	 * Values for the names the Launchfile's top-level `secrets:` block
	 * declares — the whole of what `$secrets.<name>` may resolve to
	 * (SPEC.md § Secrets). Backing-service passwords live in
	 * `resourcePasswords` and never join this map.
	 */
	secrets: Record<string, string>;
	/**
	 * Passwords this provider mints for the backing services it starts for
	 * `requires:` resources, keyed by `ResourcePasswordKey`. Disjoint from
	 * `secrets` so no value here is addressable as `$secrets.<name>`: a
	 * database password is provider-internal wiring, not something the
	 * Launchfile declared. Optional for backward compatibility — state files
	 * written before this key carry these values inside `secrets`, and
	 * `migrateResourcePasswords` moves them across on the next run.
	 */
	resourcePasswords?: Record<string, string>;
	ports: Record<string, number>;
	/**
	 * Minted `env:`-level generator values (D-49: generate once, then
	 * preserve), keyed `<component>.<ENV_NAME>` — one entry per declaration
	 * (D-25), so same-named variables on different components hold independent
	 * values. `generator: port` values are never stored here (ports are
	 * re-allocated each run). Kept disjoint from `secrets`, which holds only
	 * the names the Launchfile's `secrets:` block declares — env-var names must
	 * not join it or become resolvable as `$secrets.<name>`. Optional for
	 * backward compatibility: older state files omit it and load as a first
	 * run.
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
	/**
	 * Orchestrator-supplied publication context (#290): the normalized public
	 * URL `$app.*` resolves from, persisted alongside `ports` so later verbs
	 * (bootstrap) and re-runs resolve the same values as the `up` that set it.
	 * A subsequent `up` that supplies a different value replaces it and the
	 * derived env recomputes (D-49); a run that omits it preserves what is
	 * recorded. Optional for backward compatibility — absent means the
	 * provider's own localhost routing answers.
	 */
	appUrl?: string;
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

/**
 * The digest recorded in `DockerState.launchfileHash`, over the Launchfile
 * text a deployment was produced from. Truncated to 16 hex chars: this
 * detects an edit, it does not authenticate one.
 */
export function hashLaunchfile(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isType(value: unknown, expected: "string" | "number"): boolean {
	return expected === "string" ? typeof value === "string" : typeof value === "number";
}

/**
 * One warning per dropped key, naming the file it came from so an operator
 * can find and repair it. Goes through pino to stderr — a load happens under
 * every verb, including ones whose stdout is the answer (`status`, `list`).
 */
function warnDropped(file: string, key: string, expected: string): void {
	getLogger().warn({ stateFile: file, key, expected }, "ignoring invalid key in state file");
}

/** Top-level fields that hold a string when present. */
const STRING_FIELDS = [
	"slug",
	"appName",
	"composeProject",
	"launchfileHash",
	"createdAt",
	"updatedAt",
	"sourceType",
	"sourcePath",
	"sourceUrl",
	"appUrl",
] as const;

/**
 * Drop the entries of a `Record<string, T>` field whose values are not `T`,
 * and the whole field when it is not an object at all. Returns the surviving
 * map, or undefined when the field is absent or was dropped.
 */
function checkValueMap(
	parsed: Record<string, unknown>,
	key: string,
	file: string,
	valueType: "string" | "number",
): Record<string, unknown> | undefined {
	const value = parsed[key];
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		warnDropped(file, key, "object");
		delete parsed[key];
		return undefined;
	}
	for (const [entryKey, entryValue] of Object.entries(value)) {
		if (!isType(entryValue, valueType)) {
			warnDropped(file, `${key}.${entryKey}`, valueType);
			delete value[entryKey];
		}
	}
	return value;
}

function isStateEndpoint(value: unknown): boolean {
	return (
		isPlainObject(value) &&
		typeof value.component === "string" &&
		typeof value.containerPort === "number" &&
		typeof value.hostPort === "number" &&
		(value.name === undefined || typeof value.name === "string") &&
		(value.protocol === undefined || typeof value.protocol === "string")
	);
}

/**
 * Check a parsed state file field by field, in place, and hand back what
 * survived. A field that fails its check is dropped and every other field is
 * kept — a state file is an operator's record of a running deployment, so
 * discarding all of it over one bad key would orphan real containers.
 *
 * Keys this function does not know are left untouched, so a field written by
 * a newer provider version survives a load-and-save round trip through an
 * older one instead of being written out of existence (P-13).
 *
 * `ports` is the one field with a default: every consumer reads it
 * unguarded (`Object.keys(state.ports)`), so an absent or malformed map has
 * to become `{}` here or it becomes a TypeError with no file name in it.
 */
function validateState(parsed: Record<string, unknown>, file: string): DockerState {
	if (parsed.version !== undefined && typeof parsed.version !== "number") {
		warnDropped(file, "version", "number");
		delete parsed.version;
	}

	for (const key of STRING_FIELDS) {
		if (parsed[key] !== undefined && typeof parsed[key] !== "string") {
			warnDropped(file, key, "string");
			delete parsed[key];
		}
	}

	checkValueMap(parsed, "secrets", file, "string");
	checkValueMap(parsed, "resourcePasswords", file, "string");
	checkValueMap(parsed, "generatedEnv", file, "string");

	const portsPresent = parsed.ports !== undefined;
	if (checkValueMap(parsed, "ports", file, "number") === undefined) {
		// An absent map breaks the readers exactly as a malformed one does, so
		// both end at `{}`. Only the absent case warns here — `checkValueMap`
		// has already warned about a malformed one.
		if (!portsPresent) warnDropped(file, "ports", "object");
		parsed.ports = {};
	}

	const endpoints = parsed.endpoints;
	if (endpoints !== undefined) {
		if (!isPlainObject(endpoints)) {
			warnDropped(file, "endpoints", "object");
			delete parsed.endpoints;
		} else {
			for (const [entryKey, entryValue] of Object.entries(endpoints)) {
				if (!isStateEndpoint(entryValue)) {
					warnDropped(file, `endpoints.${entryKey}`, "endpoint");
					delete endpoints[entryKey];
				}
			}
		}
	}

	// Every field named in `DockerState` has now been checked or dropped. A
	// required one the file never carried stays absent — callers that read it
	// see undefined instead of a value invented here.
	return parsed as unknown as DockerState;
}

export async function loadState(slug: string): Promise<DockerState | null> {
	const file = statePath(slug);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
	// A document that is not a JSON object holds no field to keep, so there is
	// nothing to salvage — the same answer as unreadable bytes.
	if (!isPlainObject(parsed)) {
		getLogger().warn({ stateFile: file }, "state file is not a JSON object");
		return null;
	}
	const state = validateState(parsed, file);
	// Persisted secrets are reused across runs, so a value generated in an
	// earlier process still has to be scrubbable in this one (D-18).
	registerSecrets(Object.values(state.secrets ?? {}));
	registerSecrets(Object.values(state.resourcePasswords ?? {}));
	registerSecrets(Object.values(state.generatedEnv ?? {}));
	return state;
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
		launchfileHash: hashLaunchfile(launchfileContent),
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
