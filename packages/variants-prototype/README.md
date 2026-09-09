# Named application variants: runnable concept D

**Deferred research demonstration for [#447](https://github.com/launchfile/launchfile/issues/447), related to [#314](https://github.com/launchfile/launchfile/issues/314).** The [Steward review](https://github.com/launchfile/launchfile/issues/447#issuecomment-5604015259) identifies missing catalog motivation and an Author decision under D-36. This private package lets reviewers inspect the mechanics; it does not meet the adoption bar, add a feature to `launch/v1`, or change the production SDK, parser, schema, or providers.

The author defines supported app configurations together. The consumer selects one name:

```yaml
# Append to the shipped Gitea entry; its required PostgreSQL baseline stays intact.
variants:
  sqlite:
    requires: []
    env:
      GITEA__database__DB_TYPE: sqlite3
      GITEA__database__PATH: /data/gitea/gitea.db
      GITEA__server__ROOT_URL: $app.url
```

**The shipped `catalog/apps/gitea/Launchfile` requires PostgreSQL and defaults `DB_TYPE` to `postgres`; it declares no SQLite choice.** [The proposed edit](examples/gitea/catalog-edit/Launchfile) keeps that exact SDK-normalized baseline and adds a new, explicitly selected SQLite configuration. This is an author edit to assess, not a claim about the existing catalog or a tested SQLite deployment. Gitea's upstream [configuration reference](https://docs.gitea.com/administration/config-cheat-sheet/) documents the database alternatives.

The original [SQLite-first mechanics example](examples/gitea/Launchfile) remains for comparison with two complete ordinary files, but is expressly a proposed different baseline. [An alternative using existing `supports`/`set_env`](examples/gitea/supports/Launchfile) supplies the same PostgreSQL bindings without variants. [The three-app assessment](evidence/catalog-assessment.md) explains why Gitea, Flowise, and Mealie do not establish three unmet needs for this mechanism.

## Try it

From this repository's root:

```sh
bun install --frozen-lockfile
bun run --cwd packages/variants-prototype verify
bun run --cwd packages/variants-prototype demo:catalog
bun run --cwd packages/variants-prototype demo:catalog-sqlite
```

For another file, run from this package:

```sh
bun run inspect path/to/Launchfile
bun run inspect path/to/Launchfile --variant=sqlite
```

Both commands print JSON with `selected`, `available`, `validated`, `requiredInputs`, `lifecycle`, and an SDK-normalized `launch`. No selection chooses the baseline. In the proposed catalog edit, `--variant=sqlite` removes the mandatory PostgreSQL entry and replaces the environment map. A `requiredInputs` entry identifies a consumer value still needed; the prototype never invents that value. Empty `requiredInputs` does not prove deployability or that a provider can supply the declared backing services.

The output is an inspection preview, not a provider deployment plan. `$app.url`, `$password`, and `$secrets.key` remain expressions. It loads no environment values, generates no secrets, and writes no files. Explicitly sensitive defaults and common credential-named defaults/bindings are redacted. Redaction cannot identify arbitrary secrets hidden under innocent names: use references and declarations, never actual credential material, in these demonstration files.

## Validation coverage and prototype ownership

Local verification of the implementation at [fe6f19a](https://github.com/launchfile/launchfile/commit/fe6f19adb1e6360eea01718738d8611c9b81c89d) passes SDK build, strict TypeScript, and **96 prototype tests**. This is a recorded local result, not a CI guarantee. The repository's workflows do not build, typecheck, or test `packages/variants-prototype`; the `packages/**` smoke-workflow trigger tests published packages instead. Green repository checks therefore do not establish that this experiment still works after SDK or dependency changes. Run `bun run --cwd packages/variants-prototype verify` from the repository root before relying on a changed checkout or reporting fresh evidence.

Ownership stays with PR #453's author while this disposable experiment is used for RFC #447 research; it creates no ongoing production-maintainer support obligation. Author rejection of the concept, supersession by a separately reviewed production implementation, or abandonment without someone maintaining its local verification are removal triggers. The owner should propose a separate reviewed cleanup of this private package and its Bun-managed lockfile entries at that point. No automatic deletion or production migration is implemented here.

Approval of this PR as demonstration material does not accept RFC #447, ratify `variants` syntax or the proposed D-36 fourth home, supply the missing catalog motivations, or make this package a format precedent. Any accepted production feature needs its own specification/SDK/provider review; the research issue remains unresolved until its decision gates are met.

## Exact prototype rules

- One image-based component; at most 32 named variants; one explicit selection. `baseline` is reserved for the no-selection result. There is no automatic choice, variant combination, or inheritance between variants.
- Exactly six fields can change: `provides`, `requires`, `supports`, `env`, `health`, and `storage`. Missing fields inherit. Present fields replace the whole map/list/object. `{}` and `[]` clear fields where ordinary schema validation and references still permit them. `null` is not a delete marker.
- Baseline metadata, `image`, `restart`, `singleton`, and `secrets` declarations are retained. Source/build/runtime/commands, components, platform/host configuration, schedules, dependency ordering, provider/environment presets, and resource allocation fields are outside this image-based demonstration. A name cannot alter the execution mode or identity.
- Raw keys are checked before SDK normalization, including nested field objects. Unknown fields and proposed TLS/public-HTTPS declarations are refused even in nonselected variants. The package does not silently strip contracts from #445 or #446.
- The baseline and **every** expanded variant must pass raw checks, the existing SDK schema, and prototype semantic checks before selection returns anything. These include declared resource/secret/storage references, endpoint names/port collisions, resource names, and optional-resource fallback requirements. Only SDK standard backing-service types/properties and standard `$app`/`$storage` properties are supported here. This stricter demo boundary is not a proposal to close the specification's open resource vocabulary.
- References are inspected in environment defaults and `set_env`, where the existing expression resolver applies. URL-shaped `$app` references need exactly one exposed HTTP(S) endpoint in this prototype; `$app.name` does not. Component references are refused. Values remain unresolved. YAML alias sharing cannot cause selection to mutate input or another result; cyclic aliases are rejected.

The selected `launch` has the same normalized structure as a complete ordinary equivalent file. The wrapper's selection metadata is not passed into Launchfile semantics.

## Existing deployment boundary

An integration checking an existing deployment must supply that deployment's previous selection through the separate `SelectionContext` argument. `null` means an existing baseline; an absent property means no lifecycle check was requested, which the output reports explicitly. The CLI exposes this caller assertion as `--previous-variant=<name|baseline>`:

```sh
# Existing PostgreSQL baseline, still selected: preview allowed.
bun run inspect examples/gitea/catalog-edit/Launchfile --previous-variant=baseline

# Existing PostgreSQL baseline, now requesting SQLite: refused before expansion.
bun run inspect examples/gitea/catalog-edit/Launchfile --previous-variant=baseline --variant=sqlite
```

Changing the selection of an existing deployment is refused before YAML parsing or normalization. The baseline is a real selection, so baseline-to-name and name-to-baseline both refuse. The same selection remains subject to all normal candidate checks. Selecting a different configuration belongs to a separate, user-controlled new-deployment lifecycle with explicit data handling; this package implements no destruction, recreation, or migration.

The caller owns history lookup, persistence, and association with the correct deployment identity. The package reads no sidecar/state file or environment values. Omitted history proves nothing about redeploy safety. Comparing names cannot detect a changed definition under the same name, a changed image, or changed storage contents, so an allowed preview is never a data-compatibility claim.

## Author decision and terminology

If pursued, this proposes a **fourth D-36 home**: app-authored alternative configurations selected by the consumer. That would amend D-36's current exhaustive three-home rule; it is not an interpretation of home #1, whose variation is source/artifact execution intent. No Author amendment has been accepted.

This document calls the proposal an **in-file configuration choice**. D-43's **source declaration variant** is a separate whole Launchfile with its own repository baseline `#ref`. D-43 explicitly fences off general in-file baseline configuration; this choice mechanism therefore needs its own decision under that fence. Existing experimental `variants`/`--variant` spellings remain only for comparing the prototype, not as a terminology decision. D-37 remains binary source/artifact. L-3's possible `Launchfile.override` for orchestrator config values is neither implemented nor assigned precedence by this work; reusing D-25's replacement rule here does not decide a future override mechanism.

## What this proves, and what remains open

The tests compare actual expansion with the existing SDK reading two independently written complete Gitea configurations and preserve the shipped PostgreSQL baseline in the proposed catalog edit. They check existing optional database bindings in tested-tier Flowise/Mealie entries, compare the existing-syntax Gitea alternative, and cover redeploy refusal, invalid nonselected variants, dangling references after clears, unknown contracts, port/name ambiguity, alias mutation, CLI failures, unresolved expressions, and redaction.

This does **not** launch Gitea, PostgreSQL, or any provider. Selecting PostgreSQL for an existing SQLite installation does **not** migrate data, validate a database connection, or make changing a persisted installation safe. The examples are configuration comparisons; no live transition is claimed. The image tag is illustrative and is never pulled by these scripts.

The candidate still needs the decision requested in #447: does this mechanism earn its complexity compared with `supports`/`set_env`, a dedicated capability, or two complete Launchfiles? P-3/P-9/P-10 motivate deterministic validation and inspection. P-2/P-4/P-7 still face repeated maps and new author rules. D-25's component inheritance is precedent to compare, not authorization; D-36's varying-value homes and D-37's execution modes remain unchanged by this demonstration.

Do not pass a file containing `variants` directly to current `launchfile` tools: older readers can strip the field and run the baseline. Feature negotiation/refusal in real consumers remains an adoption requirement. This private command's strict parsing is only local demonstration protection.
