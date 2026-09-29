/**
 * State management for the macOS dev provider.
 *
 * Persists secrets, ports, and resource state in .launchfile/state.json
 * so credentials and ports are stable across restarts.
 */

import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { registerSecrets } from "./redact.js";
import {
	assertSafeIdentifier,
	assertSafePassword,
} from "./resources/identifiers.js";
import type { DbIndexes } from "./resources/uses.js";

export interface ResourceState {
	type: string;
	name: string;
	brewService?: string;
	port: number;
	dbName?: string;
	user?: string;
	password?: string;
	/**
	 * The numbered database `up` allocated to this resource for its bare redis
	 * `db` use (SPEC.md § Resource uses). Recorded so `env` registers the same
	 * `db.url` / `db.index` the running app was given, rather than re-deriving
	 * an index from a file that may have changed since. Absent on a resource
	 * with no bare `db` use and on state written before the index was recorded.
	 */
	dbIndex?: number;
	/**
	 * The numbered database allocated to each named redis `db` use, by name
	 * (`- db: cache` → `{ cache: 1 }`), recorded for the same reason as
	 * `dbIndex`. Absent on a resource with no named `db` use.
	 */
	namedDbIndexes?: Record<string, number>;
	/**
	 * The extra databases the provisioner created for named `database` uses
	 * (`<instance>_<name>`), so `destroy` drops what `up` created. Absent on a
	 * resource with no named `database` use.
	 */
	databases?: string[];
}

/** The `db` use keys → index map `up` recorded on a resource: `db` from `dbIndex`, `db.<name>` from `namedDbIndexes`. */
export function recordedDbIndexes(res: ResourceState): DbIndexes {
	const indexes: Record<string, number> = {};
	if (res.dbIndex !== undefined) indexes.db = res.dbIndex;
	for (const [name, index] of Object.entries(res.namedDbIndexes ?? {})) {
		indexes[`db.${name}`] = index;
	}
	return indexes;
}

/** `res` with the allocated `db` indexes recorded — the inverse of {@link recordedDbIndexes}. Records nothing for an empty allocation. */
export function withRecordedDbIndexes(res: ResourceState, indexes: DbIndexes): ResourceState {
	const named: Record<string, number> = {};
	let dbIndex: number | undefined;
	for (const [key, index] of Object.entries(indexes)) {
		if (key === "db") dbIndex = index;
		else named[key.slice("db.".length)] = index;
	}
	return {
		...res,
		...(dbIndex !== undefined ? { dbIndex } : {}),
		...(Object.keys(named).length > 0 ? { namedDbIndexes: named } : {}),
	};
}

/**
 * Records a spawned app component process so `launch down` can stop it
 * from a different shell or after the foreground `launch up` session ends.
 *
 * Identity is captured at spawn time so `down` can re-verify the recorded
 * pid still belongs to the process we started before signaling it — guarding
 * against pid-reuse (a recycled pid belonging to an unrelated process).
 */
export interface ProcessState {
	/** Leader pid of the spawned shell (`sh -c <command>`). */
	pid: number;
	/**
	 * Process group id. Because we spawn detached, the child is its own group
	 * leader, so pgid === pid. We persist it explicitly so `down` can signal the
	 * whole group (negative pid) and take down child processes too.
	 */
	pgid: number;
	/** ISO timestamp captured immediately after spawn — part of the identity check. */
	startedAt: string;
	/** The shell command string we launched — used as a best-effort identity cross-check. */
	command: string;
}

export interface LaunchState {
	version: 1;
	appName: string;
	launchfileHash: string;
	createdAt: string;
	updatedAt: string;
	resources: Record<string, ResourceState>;
	secrets: Record<string, string>;
	ports: Record<string, number>;
	/**
	 * App component processes recorded at spawn time, keyed by component name.
	 * Optional for backward compatibility: state files written before pid
	 * persistence existed simply omit this, and `down` tolerates its absence.
	 */
	processes?: Record<string, ProcessState>;
	/**
	 * Minted `env:`-level generator values (D-49: generate once, then
	 * preserve), keyed `<component>.<ENV_NAME>` — one entry per declaration
	 * (D-25), so same-named variables on different components hold independent
	 * values. `generator: port` values are never stored here (ports are
	 * re-allocated each run). Disjoint from `secrets` on purpose: these names
	 * must not become resolvable as `$secrets.<name>`. Optional for backward
	 * compatibility: older state files omit it and load as a first run.
	 */
	generatedEnv?: Record<string, string>;
	/**
	 * Host paths bound to `content: operator` volumes on the last successful
	 * `up` (D-50), as `component → volume → path`. Recorded so `env` reports
	 * the directory the app actually reads, not the `.launchfile/` path an
	 * unmarked volume would have taken.
	 *
	 * It is not a substitute for supplying the paths: a later `up` without them
	 * refuses again, matching `@launchfile/docker`, which persists `appUrl` but
	 * never its storage paths. Optional for backward compatibility: state files
	 * written before this existed omit it.
	 */
	operatorStorage?: Record<string, Record<string, string>>;
	/**
	 * Orchestrator-supplied publication context (D-58): the normalized public
	 * URL `$app.*` resolves from, persisted alongside `ports` so `env` and
	 * `bootstrap` resolve the same values as the `up` that set it. A later `up`
	 * that supplies a different value replaces it and the derived env recomputes
	 * (D-49); one that omits it preserves what is recorded — the same rule
	 * `@launchfile/docker` applies to its own `appUrl`. Optional for backward
	 * compatibility — absent means this provider's own localhost routing
	 * answers.
	 */
	appUrl?: string;
	/**
	 * The `ports` key — this provider allocates one port per component, so a
	 * component name — of the app's primary endpoint, the one `$app.*` reads,
	 * when a declared `https-origin` names that endpoint (any protocol, D-60
	 * rule 4) or its effective listener is `http` or `https`; absent for a
	 * positional `ws`/`tcp`/`udp`/`grpc` primary (§7, D-58 rule 2). See
	 * `printedPrimaryEndpoint`. Recorded at `up` beside `appUrl`
	 * so `status`, which never reads the Launchfile, prints the supplied URL on
	 * that one key and no other (D-58 rule 4). Optional for backward
	 * compatibility: a state file without it prints this provider's own address
	 * on every key.
	 */
	primaryEndpoint?: string;
	/**
	 * Fingerprint of the prepare inputs (`install ?? build` command plus the
	 * dependency manifests and lockfiles in its working directory) at the last
	 * successful prepare, keyed by component name. It is what makes prepare run
	 * on demand rather than on every `up` (D-38): a component whose current
	 * fingerprint matches its recorded one has nothing to install.
	 *
	 * An entry is written only after its command exits zero, so a failed prepare
	 * is retried on the next `up`. Optional for backward compatibility: a state
	 * file written before this existed has no entries, so the next `up` prepares
	 * every component once and records them.
	 */
	prepared?: Record<string, string>;
}

const STATE_DIR = ".launchfile";
const STATE_FILE = "state.json";

function stateDir(projectDir: string): string {
	return join(projectDir, STATE_DIR);
}

function statePath(projectDir: string): string {
	return join(stateDir(projectDir), STATE_FILE);
}

export function hashLaunchfile(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPort(value: unknown): boolean {
	return (
		Number.isInteger(value) &&
		(value as number) >= 1 &&
		(value as number) <= 65535
	);
}

function isPositiveInteger(value: unknown): boolean {
	return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
	return Number.isInteger(value) && (value as number) >= 0;
}

function isStringMap(value: unknown): value is Record<string, string> {
	return (
		isPlainObject(value) &&
		Object.values(value).every((v) => typeof v === "string")
	);
}

/** True when a use-site assert accepts the value: boundary and sink share one rule. */
function passes(assert: () => void): boolean {
	try {
		assert();
		return true;
	} catch {
		return false;
	}
}

/**
 * One line per dropped field, naming the file so an operator can find and
 * repair it. `console.warn` writes to stderr: a load happens under every verb,
 * including the ones whose stdout is the answer (`status`, `env`).
 */
function warnDropped(file: string, field: string, reason: string): void {
	console.warn(`  Warning: ${file}: ignoring ${field} (${reason})`);
}

/**
 * Why a `resources` entry cannot be loaded, or null when it can. `dbName`,
 * `user` and `password` reach SQL by interpolation on the reuse path, so they
 * pass the same asserts the provisioners apply at the point of use (#258).
 */
function resourceProblem(value: unknown): string | null {
	if (!isPlainObject(value)) return "not an object";
	if (typeof value.type !== "string") return "type is not a string";
	if (typeof value.name !== "string") return "name is not a string";
	if (!isPort(value.port)) return "port is not an integer in 1-65535";
	if (
		value.brewService !== undefined &&
		typeof value.brewService !== "string"
	) {
		return "brewService is not a string";
	}
	for (const key of ["dbName", "user"] as const) {
		const identifier = value[key];
		if (identifier === undefined) continue;
		if (
			typeof identifier !== "string" ||
			!passes(() => assertSafeIdentifier(identifier, key))
		) {
			return `${key} is not a safe SQL identifier`;
		}
	}
	const password = value.password;
	if (
		password !== undefined &&
		(typeof password !== "string" ||
			!passes(() => assertSafePassword(password)))
	) {
		return "password is not base64url";
	}
	if (value.dbIndex !== undefined && !isNonNegativeInteger(value.dbIndex)) {
		return "dbIndex is not a non-negative integer";
	}
	const named = value.namedDbIndexes;
	if (
		named !== undefined &&
		!(isPlainObject(named) && Object.values(named).every(isNonNegativeInteger))
	) {
		return "namedDbIndexes is not a map of non-negative integers";
	}
	const databases = value.databases;
	if (
		databases !== undefined &&
		!(Array.isArray(databases) && databases.every((d) => typeof d === "string"))
	) {
		return "databases is not a list of strings";
	}
	return null;
}

/**
 * Why a `processes` entry cannot be loaded, or null when it can. `down`
 * signals the recorded group after `checkIdentity` compares `startedAt` with
 * the live process's start time, so a record that claims to have started in
 * the future describes no process this provider spawned and is never handed
 * to the signalling path.
 */
function processProblem(value: unknown, now: number): string | null {
	if (!isPlainObject(value)) return "not an object";
	if (!isPositiveInteger(value.pid)) return "pid is not a positive integer";
	if (!isPositiveInteger(value.pgid)) return "pgid is not a positive integer";
	if (typeof value.command !== "string") return "command is not a string";
	if (typeof value.startedAt !== "string") return "startedAt is not a string";
	const startedAt = Date.parse(value.startedAt);
	if (Number.isNaN(startedAt)) return "startedAt is not a parseable timestamp";
	if (startedAt > now) return "startedAt is in the future";
	return null;
}

/** Top-level fields holding a string when present; no reader needs them to load. */
const OPTIONAL_STRING_FIELDS = [
	"launchfileHash",
	"createdAt",
	"updatedAt",
	"appUrl",
	"primaryEndpoint",
] as const;

/** Top-level `Record<string, string>` fields. */
const STRING_MAP_FIELDS = ["secrets", "generatedEnv", "prepared"] as const;

/**
 * Drop the entries of a keyed field whose values fail `problem`, and the whole
 * field when it is not an object. Every surviving sibling stays.
 */
function checkEntries(
	parsed: Record<string, unknown>,
	key: string,
	file: string,
	problem: (value: unknown) => string | null,
): void {
	const map = parsed[key];
	if (map === undefined) return;
	if (!isPlainObject(map)) {
		warnDropped(file, key, "not an object");
		delete parsed[key];
		return;
	}
	for (const [entryKey, entryValue] of Object.entries(map)) {
		const reason = problem(entryValue);
		if (reason !== null) {
			warnDropped(file, `${key}.${entryKey}`, reason);
			delete map[entryKey];
		}
	}
}

/**
 * Check a parsed state file field by field, in place, and hand back what
 * survived. The file sits inside the project directory, so a cloned
 * repository can ship one: nothing in it is trusted until it has passed here.
 *
 * A field or entry that fails its check is dropped with a warning and every
 * other one is kept — discarding the whole file over one bad `resources`
 * entry would take `processes` with it, and `down` would leave the app's
 * processes running. Only an envelope no reader can use (`appName`,
 * `resources`, `secrets` or `ports` missing or of the wrong type) returns
 * null, with one warning naming the field.
 *
 * Keys this function does not know are left untouched, at the top level and
 * inside entries, so a field written by a newer provider version survives a
 * load-and-save round trip through an older one (P-13). Bootstrap saves
 * mid-run from the object this returns, which is why bad entries are removed
 * from the parsed object rather than a clean one rebuilt from a key list.
 */
function validateState(
	parsed: Record<string, unknown>,
	file: string,
): LaunchState | null {
	if (typeof parsed.appName !== "string") {
		warnDropped(file, "state", "appName is not a string");
		return null;
	}
	for (const key of ["resources", "secrets", "ports"] as const) {
		if (!isPlainObject(parsed[key])) {
			warnDropped(file, "state", `${key} is not an object`);
			return null;
		}
	}

	if (parsed.version !== undefined && typeof parsed.version !== "number") {
		warnDropped(file, "version", "not a number");
		delete parsed.version;
	}
	for (const key of OPTIONAL_STRING_FIELDS) {
		if (parsed[key] !== undefined && typeof parsed[key] !== "string") {
			warnDropped(file, key, "not a string");
			delete parsed[key];
		}
	}
	for (const key of STRING_MAP_FIELDS) {
		checkEntries(parsed, key, file, (v) =>
			typeof v === "string" ? null : "not a string",
		);
	}
	checkEntries(parsed, "ports", file, (v) =>
		isPort(v) ? null : "not an integer in 1-65535",
	);
	checkEntries(parsed, "operatorStorage", file, (v) =>
		isStringMap(v) ? null : "not a map of paths",
	);
	checkEntries(parsed, "resources", file, resourceProblem);
	const now = Date.now();
	checkEntries(parsed, "processes", file, (v) => processProblem(v, now));

	return parsed as unknown as LaunchState;
}

/**
 * Load state from disk, or return null if none exists or the file holds
 * nothing a reader can use. Never throws: a malformed file is a warning on
 * stderr, not a crash under `status` or `down`.
 */
export async function loadState(
	projectDir: string,
): Promise<LaunchState | null> {
	const file = statePath(projectDir);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
	if (!isPlainObject(parsed)) {
		warnDropped(file, "state", "not a JSON object");
		return null;
	}
	const state = validateState(parsed, file);
	if (state === null) return null;
	// Persisted credentials are reused verbatim in provisioning commands and
	// in `$secrets.*` / `$<resource>.*` expressions, so they must be known to
	// the redactor before anything can echo them.
	registerSecrets(Object.values(state.secrets));
	registerSecrets(Object.values(state.resources).map((r) => r.password));
	// A value minted in an earlier run and merely reused in this one never
	// passes through generateValue()'s registration, so the loader is the
	// only place it can become scrubbable (D-18).
	registerSecrets(Object.values(state.generatedEnv ?? {}));
	return state;
}

/** Create a fresh state object */
export function initState(appName: string, launchfileContent: string): LaunchState {
	const now = new Date().toISOString();
	return {
		version: 1,
		appName,
		launchfileHash: hashLaunchfile(launchfileContent),
		createdAt: now,
		updatedAt: now,
		resources: {},
		secrets: {},
		ports: {},
	};
}

/** Save state to disk */
export async function saveState(projectDir: string, state: LaunchState): Promise<void> {
	state.updatedAt = new Date().toISOString();
	// Security: restrict directory/file permissions — state.json contains
	// database passwords and generated secrets in plaintext.
	await mkdir(stateDir(projectDir), { recursive: true, mode: 0o700 });
	await writeFile(statePath(projectDir), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

/** Ensure .launchfile directories exist */
export async function ensureDirs(projectDir: string): Promise<void> {
	const dirs = ["storage", "tmp", "logs", "data", "env"];
	// Security: these dirs hold secrets, logs, and env files. mkdir applies the
	// mode only when it creates the directory, so chmod unconditionally — a dir
	// left by an earlier version or a looser umask must not stay world-readable
	// (CWE-276). Mirrors packages/launchfile/src/state/errors.ts.
	await Promise.all(
		dirs.map(async (d) => {
			const dir = join(projectDir, STATE_DIR, d);
			await mkdir(dir, { recursive: true, mode: 0o700 });
			await chmod(dir, 0o700);
		}),
	);
	// Safety net: write a .gitignore inside .launchfile/ so secrets aren't
	// accidentally committed even if the project's .gitignore doesn't exclude it.
	await writeFile(join(projectDir, STATE_DIR, ".gitignore"), "*\n", { mode: 0o644 });
}
