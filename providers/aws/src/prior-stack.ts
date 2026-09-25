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
 *   2. `main.tf` — what this provider last emitted. Consulted only when no
 *      state file is readable (remote backend, or the operator applies from
 *      another directory).
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
 * an HCL record is cleared only by moving that file aside. The re-key steps a
 * refusal prints are built from this.
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

/**
 * Read what `dir` says is already minted. Returns `undefined` when nothing is
 * minted — the fresh-stack case, where every generator is minted for the first
 * time.
 *
 * A state file that parses decides the answer on its own, even when it holds no
 * generator: after `terraform state rm` the old `main.tf` still names the
 * removed resource, and reading it would put the re-key steps in a loop. A
 * malformed state file is not a reason to guess: it falls through to `main.tf`,
 * and if that is absent too the caller is told nothing is known.
 */
export function readPriorStack(dir: string): PriorStack | undefined {
	const statePath = join(dir, "terraform.tfstate");
	if (existsSync(statePath)) {
		let generators: Record<string, GeneratorResource> | undefined;
		try {
			generators = fromState(readFileSync(statePath, "utf8"));
		} catch {
			// Unparseable state — fall through to the emitted HCL.
		}
		if (generators !== undefined) {
			return Object.keys(generators).length > 0
				? { generators, source: { kind: "state", path: statePath } }
				: undefined;
		}
	}
	const hclPath = join(dir, "main.tf");
	if (existsSync(hclPath)) {
		const generators = fromHcl(readFileSync(hclPath, "utf8"));
		if (Object.keys(generators).length > 0)
			return { generators, source: { kind: "hcl", path: hclPath } };
	}
	return undefined;
}
