/**
 * What a previous run of this provider already minted.
 *
 * A minted value — `generator: secret` / `generator: uuid` — is generated once
 * and then preserved (D-49). In Terraform the value lives in state, keyed by
 * the resource's *type and name*. Terraform cannot migrate state across a
 * resource-type change (a `moved` block only bridges renames of the same type),
 * so re-emitting the same logical secret under a different `random_*` type
 * destroys the old value and creates a new one on the next apply.
 *
 * Translation is otherwise pure, so the knowledge of "what type was this minted
 * as" has to be read from the output directory and handed to `translate()`.
 * Two sources:
 *
 *   1. `terraform.tfstate` — what `apply` actually diffs against. When it
 *      parses it is authoritative, including when it records no generator at
 *      all: that is exactly the state `terraform state rm` leaves behind, and
 *      the re-key steps depend on it reading as fresh.
 *   2. `main.tf` — what this provider last emitted. Consulted only when there
 *      is no state file at all (remote backend, or the operator applies from
 *      another directory).
 *
 * A state file that exists but does not parse is neither: it proves the
 * directory is not fresh and says nothing about what is minted, so translation
 * refuses. `main.tf` is not a substitute for it — the broken state may be newer.
 *
 * Only resource **types and names** are read. Values are never read, never
 * logged, and never reach the emitted HCL.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The `random_*` resource types this provider emits for a `generator:`. */
export const GENERATOR_RESOURCES = [
	"random_bytes",
	"random_password",
	"random_uuid",
	"random_integer",
] as const;

export type GeneratorResource = (typeof GENERATOR_RESOURCES)[number];

/**
 * Where a prior-stack record was read from. It decides what clears the record:
 * `terraform state rm` empties a state record but never touches `main.tf`, so
 * an HCL record is cleared only by naming its address to `--rekey`, which drops
 * that one record and keeps every other. The re-key steps a refusal prints are
 * built from this.
 */
export interface PriorSource {
	kind: "state" | "hcl";
	/** The file the record was read from, resolved from the output directory. */
	path: string;
}

export interface PriorStack {
	/**
	 * Terraform resource *name* → the `random_*` type it currently exists as.
	 * The name is the provider's own generator address (`lf_secret_<name>`,
	 * `<instance>_<KEY>_gen`), so a lookup can never collide with an unrelated
	 * resource.
	 */
	generators: Readonly<Record<string, GeneratorResource>>;
	/** Named in a refusal, and selects the re-key steps it prints. */
	source: PriorSource;
}

function isGeneratorResource(type: string): type is GeneratorResource {
	return (GENERATOR_RESOURCES as readonly string[]).includes(type);
}

/** `resource "random_password" "lf_secret_key" {` → name/type pairs. */
function fromHcl(hcl: string): Record<string, GeneratorResource> {
	const found: Record<string, GeneratorResource> = {};
	const pattern = /resource\s+"(random_[a-z_]+)"\s+"([A-Za-z0-9_-]+)"/g;
	for (const m of hcl.matchAll(pattern)) {
		const [, type, name] = m;
		if (type && name && isGeneratorResource(type)) found[name] = type;
	}
	return found;
}

interface StateResource {
	mode?: unknown;
	type?: unknown;
	name?: unknown;
}

/** Managed `random_*` resources recorded in a Terraform state file. */
function fromState(json: string): Record<string, GeneratorResource> {
	const found: Record<string, GeneratorResource> = {};
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null) return found;
	const resources = (parsed as { resources?: unknown }).resources;
	if (!Array.isArray(resources)) return found;
	for (const entry of resources as StateResource[]) {
		if (entry.mode !== undefined && entry.mode !== "managed") continue;
		const { type, name } = entry;
		if (typeof type !== "string" || typeof name !== "string") continue;
		if (isGeneratorResource(type)) found[name] = type;
	}
	return found;
}

export interface ReadPriorStackOptions {
	/**
	 * Terraform addresses (`<random_type>.<name>`) the operator is re-keying on
	 * purpose. Each one is dropped from the record so it mints fresh under
	 * D-47; every other record is kept, so no other minted value is touched.
	 * An address the record does not hold is an error, not a no-op: a typo
	 * here must not pass as a re-key.
	 */
	rekey?: readonly string[];
}

/**
 * A `--rekey` address that names nothing the output directory holds. Refusing
 * it keeps a mistyped address from reading as a completed re-key.
 */
export class RekeyAddressError extends Error {
	readonly address: string;

	constructor(address: string, dir: string, prior: PriorStack | undefined) {
		const held = prior
			? Object.entries(prior.generators)
					.map(([name, type]) => `  ${type}.${name}`)
					.join("\n")
			: "  (nothing — the directory records no minted value)";
		super(
			[
				`--rekey ${address}: no minted value by that address in ${dir}.`,
				`Expected \`<random_type>.<name>\` matching one of${prior ? ` the records in ${prior.source.path}` : ""}:`,
				held,
				"Nothing was written.",
			].join("\n"),
		);
		this.name = "RekeyAddressError";
		this.address = address;
	}
}

/**
 * A `terraform.tfstate` that exists but does not parse. The directory is not
 * fresh, and what it holds is unknown, so translating would mint over whatever
 * the state records — the silent rotation D-69 forbids. Refusing names the file
 * and the operator's way forward.
 */
export class UnreadableStateError extends Error {
	readonly path: string;

	constructor(path: string, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(
			[
				`Refusing to translate: ${path} exists but does not parse as Terraform state (${reason}).`,
				"",
				"A state file that cannot be read proves the stack is not fresh and says",
				"nothing about which secrets are already minted, so translating here would",
				"re-mint every one of them. Nothing was written.",
				"",
				"Either:",
				"  - repair the file, or restore it (Terraform keeps terraform.tfstate.backup",
				"    beside it; a remote backend keeps its own history), then re-translate; or",
				"  - if the stack holds nothing, remove the file deliberately and re-translate.",
			].join("\n"),
		);
		this.name = "UnreadableStateError";
		this.path = path;
	}
}

/**
 * Read what `dir` says is already minted. Returns `undefined` when nothing is
 * minted — the fresh-stack case, where every generator is minted for the first
 * time.
 *
 * A state file that parses decides the answer on its own, even when it holds no
 * generator: after `terraform state rm` the old `main.tf` still names the
 * removed resource, and reading it would put the re-key steps in a loop. A
 * state file that does not parse is not a reason to guess either way: it throws
 * `UnreadableStateError`, and `main.tf` is not consulted in its place.
 *
 * `opts.rekey` then drops exactly the named records — the only way to clear a
 * record that came from `main.tf`, since `state rm` never touches that file
 * and moving it aside would erase every other record with it.
 */
export function readPriorStack(
	dir: string,
	opts: ReadPriorStackOptions = {},
): PriorStack | undefined {
	const prior = readRecords(dir);
	const rekey = opts.rekey ?? [];
	if (rekey.length === 0) return prior;

	const generators: Record<string, GeneratorResource> = {
		...prior?.generators,
	};
	for (const address of rekey) {
		const dot = address.indexOf(".");
		const type = address.slice(0, dot);
		const name = address.slice(dot + 1);
		if (dot < 0 || generators[name] !== type) {
			throw new RekeyAddressError(address, dir, prior);
		}
		delete generators[name];
	}
	// `prior` is defined here: an empty record would have thrown above.
	return prior !== undefined && Object.keys(generators).length > 0
		? { generators, source: prior.source }
		: undefined;
}

function readRecords(dir: string): PriorStack | undefined {
	const statePath = join(dir, "terraform.tfstate");
	if (existsSync(statePath)) {
		let generators: Record<string, GeneratorResource>;
		try {
			generators = fromState(readFileSync(statePath, "utf8"));
		} catch (err) {
			throw new UnreadableStateError(statePath, err);
		}
		return Object.keys(generators).length > 0
			? { generators, source: { kind: "state", path: statePath } }
			: undefined;
	}
	const hclPath = join(dir, "main.tf");
	if (existsSync(hclPath)) {
		const generators = fromHcl(readFileSync(hclPath, "utf8"));
		if (Object.keys(generators).length > 0)
			return { generators, source: { kind: "hcl", path: hclPath } };
	}
	return undefined;
}
