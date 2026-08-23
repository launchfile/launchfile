/**
 * Structured launch failures — the shared vocabulary every provider reports through.
 *
 * Pure, no I/O (PROVIDERS.md §8: "SDK (pure, no I/O) provides the vocabulary and
 * folds … the provider/orchestrator owns the I/O"). Nothing here reads or writes a
 * file, spawns a process, or knows where a record is persisted. One shared shape
 * lives here rather than a private shape per provider so docker and macos-dev
 * report the same failure the same way (P-5).
 *
 * Two properties are load-bearing and enforced by the types rather than by
 * convention:
 *
 * 1. **Redaction happens at capture.** `buildLaunchErrorContext` takes the
 *    redactor as a required parameter and runs it over every free-text field.
 *    A secret registry is process-global and in-memory, so a reader running in a
 *    later process has an empty registry and can scrub nothing — text that
 *    reaches this object unredacted is unredactable from then on (CWE-532).
 * 2. **A context cannot hold an environment value.** The only env-shaped field is
 *    `envKeys`, whose type is constructible solely from the *keys* of a map. An
 *    env value has no field to land in, so the leak is unrepresentable rather
 *    than merely avoided.
 */

// ---------------------------------------------------------------------------
// Phases, slots, dispositions
// ---------------------------------------------------------------------------

/**
 * Lifecycle slots (PROVIDERS.md §3). A slot is a lifecycle phase; which command
 * fills it is a mode-resolution detail (D-38).
 */
export type LaunchSlot =
	| "prepare"
	| "release"
	| "run"
	| "bootstrap"
	| "on-demand";

/**
 * Where a launch failed. Slot phases come from the D-48 failure table; the rest
 * are real failure points that fill no lifecycle slot — a missing prerequisite,
 * an unresolvable source, an unparseable Launchfile, resource/compose
 * provisioning, and the health gate.
 *
 * Deliberately **not** keyed on command names: D-38 lets one command fill a slot
 * in either mode (source prepare resolves `install ?? build`, source run resolves
 * `dev ?? start`), so `build` and `start` each name two different things while
 * `prepare` and `run` each name one.
 */
export type LaunchPhase =
	| LaunchSlot
	| "prereq"
	| "resolve"
	| "parse"
	| "provision"
	| "health"
	| "unknown";

/** What the failure did to the caller, per the D-48 failure table. */
export type LaunchDisposition =
	| "failed-invocation"
	| "failed-deploy"
	| "reported";

/** Execution mode (PROVIDERS.md §4, D-37/D-38). */
export type ExecutionMode = "artifact" | "source";

export const LAUNCH_SLOTS: readonly LaunchSlot[] = [
	"prepare",
	"release",
	"run",
	"bootstrap",
	"on-demand",
];

export const LAUNCH_PHASES: readonly LaunchPhase[] = [
	...LAUNCH_SLOTS,
	"prereq",
	"resolve",
	"parse",
	"provision",
	"health",
	"unknown",
];

export function isLaunchPhase(value: unknown): value is LaunchPhase {
	return (
		typeof value === "string" &&
		(LAUNCH_PHASES as readonly string[]).includes(value)
	);
}

/**
 * The slot a lifecycle command fills. Mode-invariant by construction — that is
 * the point of keying on slots: `build` fills *prepare* whether it is the
 * artifact-mode build or the source-mode `install ?? build` fallback, and `start`
 * fills *run* whether it is the artifact entrypoint or the `dev ?? start`
 * fallback. Use `commandForSlot` for the other direction, where mode decides.
 */
export function slotForCommand(command: string): LaunchSlot {
	switch (command) {
		case "build":
		case "install":
			return "prepare";
		case "release":
			return "release";
		case "start":
		case "dev":
			return "run";
		case "bootstrap":
			return "bootstrap";
		default:
			return "on-demand";
	}
}

/**
 * Which declared command fills `slot` in `mode` (D-38 resolution). `declared` is
 * the set of command names the component actually declares. Returns undefined
 * when the slot is unfilled, or for `on-demand`, which no single command owns.
 */
export function commandForSlot(
	slot: LaunchSlot,
	mode: ExecutionMode,
	declared: Iterable<string>,
): string | undefined {
	const has = new Set(declared);
	const first = (...names: string[]): string | undefined =>
		names.find((n) => has.has(n));

	switch (slot) {
		case "prepare":
			return mode === "source" ? first("install", "build") : first("build");
		case "run":
			return mode === "source" ? first("dev", "start") : first("start");
		case "release":
			return first("release");
		case "bootstrap":
			return first("bootstrap");
		case "on-demand":
			return undefined;
	}
}

/**
 * The D-48 disposition table, stored rather than re-derived by every reader.
 *
 * prepare and run fail the invocation — the deploy when deploying, the session
 * when running from source. `release` fails the deploy. `bootstrap` and the
 * on-demand commands are reported to the invoker and never affect deploy status.
 * A health gate is not a command slot but SPEC.md § Failure semantics gives it a
 * disposition: a component that never becomes healthy fails the invocation. The
 * pre-slot phases fail the invocation because nothing ran at all.
 */
export function dispositionForPhase(phase: LaunchPhase): LaunchDisposition {
	switch (phase) {
		case "release":
			return "failed-deploy";
		case "bootstrap":
		case "on-demand":
			return "reported";
		default:
			return "failed-invocation";
	}
}

// ---------------------------------------------------------------------------
// Env keys — names only, enforced by the type
// ---------------------------------------------------------------------------

declare const ENV_KEYS_ONLY: unique symbol;

/**
 * A list of environment variable *names*. The brand is unforgeable outside this
 * module and `envKeysOf` is the only constructor, so the value side of an env
 * map has no route into a `LaunchErrorContext`: assigning a `string[]` of values
 * does not typecheck.
 */
export type EnvKeyList = readonly string[] & { readonly [ENV_KEYS_ONLY]: true };

/** Build an {@link EnvKeyList} from the keys of an env map. Values are dropped. */
export function envKeysOf(env: Readonly<Record<string, unknown>>): EnvKeyList {
	return Object.keys(env).sort() as unknown as EnvKeyList;
}

// ---------------------------------------------------------------------------
// Text sanitizing
// ---------------------------------------------------------------------------

/** Captured tails keep at most this many trailing lines. */
export const TAIL_LINES = 200;

/** Each retained line is truncated to this many characters, after redaction. */
export const MAX_LINE_CHARS = 2000;

// CSI and the single-character escapes a terminal writes into captured output.
const ANSI_ESCAPE =
	/\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

// Everything unprintable except \t and \n. \r is included: a log aggregator
// consuming --json treats a stray CR as a record separator (CWE-117).
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Strip ANSI escapes and control characters, keeping tabs and newlines. */
export function stripControl(text: string): string {
	return text.replace(ANSI_ESCAPE, "").replace(CONTROL_CHARS, "");
}

/** Keep the last `max` lines of `text`. */
export function tailLines(text: string, max: number = TAIL_LINES): string {
	const lines = text.split("\n");
	if (lines.length <= max) return text;
	return lines.slice(-max).join("\n");
}

/** A function that removes known-secret material from a string. */
export type Redactor = (text: string) => string;

/**
 * Trim, strip, redact, cap — in that order, and the order matters.
 *
 * Trimming to whole lines first cannot split a secret, because a secret does not
 * span a newline; stripping before redacting means an escape sequence written
 * *inside* a credential cannot break the literal match that scrubs it; capping
 * last means the character-boundary cut happens only on text that no longer
 * contains a secret to cut in half.
 */
function sanitize(text: string, redact: Redactor): string {
	const capped = redact(stripControl(tailLines(text)))
		.split("\n")
		.map((line) =>
			line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line,
		);
	return capped.join("\n");
}

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

/** An unsupplied `required:` env var (D-52, PROVIDERS.md §10 rule 8). */
export interface UnsuppliedRequirement {
	readonly component: string;
	readonly variable: string;
}

/** The persisted, already-redacted record of one launch failure. */
export interface LaunchErrorContext {
	readonly version: 1;
	/** ISO-8601 capture time. */
	readonly timestamp: string;
	readonly phase: LaunchPhase;
	/** Derived from `phase` via the D-48 table at capture time, never by the reader. */
	readonly disposition: LaunchDisposition;
	/** Provider that captured this — `"docker"`, `"macos-dev"`. */
	readonly provider: string;
	/** Storage key this record belongs to. Identifies the app, not the run. */
	readonly key: string;
	readonly message: string;
	readonly app?: string;
	readonly slug?: string;
	readonly component?: string;
	/** The command as the provider echoes it — the redacted form, never the raw one. */
	readonly command?: string;
	readonly exitCode?: number;
	readonly stdout?: string;
	readonly stderr?: string;
	/** Log tails keyed by service/process name. */
	readonly serviceLogs?: Readonly<Record<string, string>>;
	/** Declared env var **names**. There is no field for a value (see {@link EnvKeyList}). */
	readonly envKeys?: EnvKeyList;
	/** Unsupplied `required:` vars (D-52). Reserved — neither reference provider fails on these yet (#192). */
	readonly unsupplied?: readonly UnsuppliedRequirement[];
	/** What the launch reported alongside what killed it — e.g. the D-51 unexecuted-`schedule` warning. */
	readonly warnings?: readonly string[];
}

/** What a provider hands to {@link buildLaunchErrorContext}. */
export interface LaunchErrorInput {
	phase: LaunchPhase;
	provider: string;
	key: string;
	message: string;
	timestamp?: string;
	app?: string;
	slug?: string;
	component?: string;
	command?: string;
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	serviceLogs?: Readonly<Record<string, string>>;
	/** An env map. Only its keys are read; no value survives this call. */
	env?: Readonly<Record<string, unknown>>;
	unsupplied?: readonly UnsuppliedRequirement[];
	warnings?: readonly string[];
}

/**
 * Build a launch-error context, running `redact` over every free-text field.
 *
 * `redact` is required, not optional, because the provider's secret registry is
 * live only in the failing process. A caller that has no secrets to scrub passes
 * the identity function and says so at the call site.
 */
export function buildLaunchErrorContext(
	input: LaunchErrorInput,
	redact: Redactor,
): LaunchErrorContext {
	const clean = (text: string | undefined): string | undefined =>
		text === undefined ? undefined : sanitize(text, redact);

	const serviceLogs = input.serviceLogs
		? Object.fromEntries(
				Object.entries(input.serviceLogs).map(([service, log]) => [
					stripControl(service),
					sanitize(log, redact),
				]),
			)
		: undefined;

	return {
		version: 1,
		timestamp: input.timestamp ?? new Date().toISOString(),
		phase: input.phase,
		disposition: dispositionForPhase(input.phase),
		provider: input.provider,
		key: input.key,
		message: sanitize(input.message, redact),
		app: input.app,
		slug: input.slug,
		component: input.component,
		command: clean(input.command),
		exitCode: input.exitCode,
		stdout: clean(input.stdout),
		stderr: clean(input.stderr),
		serviceLogs,
		envKeys: input.env ? envKeysOf(input.env) : undefined,
		unsupplied: input.unsupplied,
		warnings: input.warnings?.map((w) => sanitize(w, redact)),
	};
}

/** An error carrying the structured context of the launch failure that caused it. */
export class LaunchError extends Error {
	readonly context: LaunchErrorContext;

	constructor(context: LaunchErrorContext) {
		super(context.message);
		this.name = "LaunchError";
		this.context = context;
	}
}

export function isLaunchError(value: unknown): value is LaunchError {
	return value instanceof LaunchError;
}

/**
 * Validate a parsed JSON record as a {@link LaunchErrorContext}. Returns null for
 * anything that is not one, so a reader never has to trust a file on disk.
 *
 * `envKeys` is rebuilt through {@link envKeysOf} rather than cast, so the
 * names-only guarantee survives the round trip through JSON.
 */
export function parseLaunchErrorContext(
	value: unknown,
): LaunchErrorContext | null {
	if (typeof value !== "object" || value === null) return null;
	const raw = value as Record<string, unknown>;
	if (raw.version !== 1) return null;
	if (!isLaunchPhase(raw.phase)) return null;
	if (typeof raw.message !== "string") return null;
	if (typeof raw.provider !== "string") return null;
	if (typeof raw.key !== "string") return null;
	if (typeof raw.timestamp !== "string") return null;

	const strings = (field: unknown): readonly string[] | undefined =>
		Array.isArray(field) && field.every((e) => typeof e === "string")
			? (field as string[])
			: undefined;

	const envKeys = strings(raw.envKeys);
	const logs =
		typeof raw.serviceLogs === "object" && raw.serviceLogs !== null
			? Object.fromEntries(
					Object.entries(raw.serviceLogs as Record<string, unknown>).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: undefined;

	const optional = (field: unknown): string | undefined =>
		typeof field === "string" ? field : undefined;

	return {
		version: 1,
		timestamp: raw.timestamp,
		phase: raw.phase,
		disposition: dispositionForPhase(raw.phase),
		provider: raw.provider,
		key: raw.key,
		message: raw.message,
		app: optional(raw.app),
		slug: optional(raw.slug),
		component: optional(raw.component),
		command: optional(raw.command),
		exitCode: typeof raw.exitCode === "number" ? raw.exitCode : undefined,
		stdout: optional(raw.stdout),
		stderr: optional(raw.stderr),
		serviceLogs: logs,
		envKeys: envKeys
			? envKeysOf(Object.fromEntries(envKeys.map((k) => [k, 0])))
			: undefined,
		unsupplied: Array.isArray(raw.unsupplied)
			? (raw.unsupplied.filter(
					(u): u is UnsuppliedRequirement =>
						typeof u === "object" &&
						u !== null &&
						typeof (u as UnsuppliedRequirement).component === "string" &&
						typeof (u as UnsuppliedRequirement).variable === "string",
				) as readonly UnsuppliedRequirement[])
			: undefined,
		warnings: strings(raw.warnings),
	};
}
