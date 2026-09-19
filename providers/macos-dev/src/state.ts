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

/** Load state from disk, or return null if none exists */
export async function loadState(projectDir: string): Promise<LaunchState | null> {
	try {
		const raw = await readFile(statePath(projectDir), "utf8");
		const state = JSON.parse(raw) as LaunchState;
		// Persisted credentials are reused verbatim in provisioning commands and
		// in `$secrets.*` / `$<resource>.*` expressions, so they must be known to
		// the redactor before anything can echo them.
		registerSecrets(Object.values(state.secrets ?? {}));
		registerSecrets(Object.values(state.resources ?? {}).map((r) => r.password));
		// A value minted in an earlier run and merely reused in this one never
		// passes through generateValue()'s registration, so the loader is the
		// only place it can become scrubbable (D-18).
		registerSecrets(Object.values(state.generatedEnv ?? {}));
		return state;
	} catch {
		return null;
	}
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
