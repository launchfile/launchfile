# Named application variants: runnable concept D

**Experimental, unaccepted demonstration for [#447](https://github.com/launchfile/launchfile/issues/447), related to [#314](https://github.com/launchfile/launchfile/issues/314).** This private package lets reviewers try the proposed author/consumer interaction. It does not add a feature to `launch/v1`, establish a format decision, or change the production SDK, parser, schema, or providers.

The author defines supported app configurations together. The consumer selects one name:

```yaml
name: gitea
image: gitea/gitea:latest
env:
  GITEA__database__DB_TYPE: sqlite3
  GITEA__server__ROOT_URL: $app.url
variants:
  postgres:
    requires:
      - type: postgres
        set_env:
          GITEA__database__DB_TYPE: postgres
          GITEA__database__HOST: ${host}:${port}
          GITEA__database__NAME: $name
          GITEA__database__USER: $user
          GITEA__database__PASSWD: $password
    env:
      GITEA__server__ROOT_URL: $app.url
```

This abbreviated example shows the choice. [The complete example](examples/gitea/Launchfile) also declares the HTTP listener, persistent storage, SQLite path, health check, and disabled SSH. Its database settings follow [Gitea's configuration reference](https://docs.gitea.com/administration/config-cheat-sheet/). It compares against two complete ordinary Launchfiles: [SQLite](examples/gitea/sqlite/Launchfile) and [PostgreSQL](examples/gitea/postgres/Launchfile).

## Try it

From this repository's root:

```sh
bun install --frozen-lockfile
bun run --cwd packages/variants-prototype verify
bun run --cwd packages/variants-prototype demo:sqlite
bun run --cwd packages/variants-prototype demo:postgres
```

For another file, run from this package:

```sh
bun run inspect path/to/Launchfile
bun run inspect path/to/Launchfile --variant=postgres
```

Both commands print JSON with `selected`, `available`, `validated`, `requiredInputs`, and an SDK-normalized `launch`. No selection chooses the baseline. The PostgreSQL selection removes the SQLite environment map and binds the required database's properties. A `requiredInputs` entry identifies a consumer value still needed; the prototype never invents that value. Empty `requiredInputs` does not prove deployability or that a provider can supply the declared backing services.

The output is an inspection preview, not a provider deployment plan. `$app.url`, `$password`, and `$secrets.key` remain expressions. It loads no environment values, generates no secrets, and writes no files. Explicitly sensitive defaults and common credential-named defaults/bindings are redacted. Redaction cannot identify arbitrary secrets hidden under innocent names: use references and declarations, never actual credential material, in these demonstration files.

## Exact prototype rules

- One image-based component; at most 32 named variants; one explicit selection. `baseline` is reserved for the no-selection result. There is no automatic choice, variant combination, or inheritance between variants.
- Exactly six fields can change: `provides`, `requires`, `supports`, `env`, `health`, and `storage`. Missing fields inherit. Present fields replace the whole map/list/object. `{}` and `[]` clear fields where ordinary schema validation and references still permit them. `null` is not a delete marker.
- Baseline metadata, `image`, `restart`, `singleton`, and `secrets` declarations are retained. Source/build/runtime/commands, components, platform/host configuration, schedules, dependency ordering, provider/environment presets, and resource allocation fields are outside this image-based demonstration. A name cannot alter the execution mode or identity.
- Raw keys are checked before SDK normalization, including nested field objects. Unknown fields and proposed TLS/public-HTTPS declarations are refused even in nonselected variants. The package does not silently strip contracts from #445 or #446.
- The baseline and **every** expanded variant must pass raw checks, the existing SDK schema, and prototype semantic checks before selection returns anything. These include declared resource/secret/storage references, endpoint names/port collisions, resource names, and optional-resource fallback requirements. Only SDK standard backing-service types/properties and standard `$app`/`$storage` properties are supported here. This stricter demo boundary is not a proposal to close the specification's open resource vocabulary.
- References are inspected in environment defaults and `set_env`, where the existing expression resolver applies. URL-shaped `$app` references need exactly one exposed HTTP(S) endpoint in this prototype; `$app.name` does not. Component references are refused. Values remain unresolved. YAML alias sharing cannot cause selection to mutate input or another result; cyclic aliases are rejected.

The selected `launch` has the same normalized structure as a complete ordinary equivalent file. The wrapper's selection metadata is not passed into Launchfile semantics.

## What this proves, and what remains open

The tests compare actual expansion with the existing SDK reading two independently written complete Gitea configurations. They also check invalid nonselected variants, dangling references after clears, unknown contracts, port/name ambiguity, alias mutation, CLI failures, unresolved expressions, and redaction.

This does **not** launch Gitea, PostgreSQL, or any provider. Selecting PostgreSQL for an existing SQLite installation does **not** migrate data, validate a database connection, or make changing a persisted installation safe. The examples are configuration comparisons; no live transition is claimed. The image tag is illustrative and is never pulled by these scripts.

The candidate still needs the decision requested in #447: does this mechanism earn its complexity compared with `supports`/`set_env`, a dedicated capability, or two complete Launchfiles? P-3/P-9/P-10 motivate deterministic validation and inspection. P-2/P-4/P-7 still face repeated maps and new author rules. D-25's component inheritance is precedent to compare, not authorization; D-36's varying-value homes and D-37's execution modes remain unchanged by this demonstration.

Do not pass a file containing `variants` directly to current `launchfile` tools: older readers can strip the field and run the baseline. Feature negotiation/refusal in real consumers remains an adoption requirement. This private command's strict parsing is only local demonstration protection.
