# AWS Provider — Working Context

> For project-wide context, see [../../CLAUDE.md](../../CLAUDE.md)

## Status: Alpha

Emitted HCL passes `terraform validate` (real AWS schema), but **unproven against
a live AWS account** and **illustrative, not deployable** — no IAM instance
profile delivers the SSM env, and source is assumed already on the instance.
Beta gate: a creds-gated `terraform plan` smoke + the IAM/SSM-delivery path.

## What's Here

A **translation-only** Launchfile provider: Launchfile → Terraform (HCL) for
EC2 + RDS + ALB. It is a spec-conformance **probe**, not a deployment tool. It
implements the `translate` verb and nothing else (no `up`/`down`/`status`).

## Philosophy

- **Translate, never apply.** The output is `.tf` + a conformance report. No
  AWS account, no credentials, no billing. CI proves validity with
  `terraform validate` against the real provider schema.
- **Build from the portable contract.** EC2 cloud-init builds from
  `runtime` + `commands` with **no Dockerfile** — the RFC C / #78 contract path.
  `build.dockerfile`/`target`/`args` are recorded as *ignored*, never errored.
- **Artifact-only mode.** Source-mode fields (`source`/`install`/`dev`) are
  ignored per D-38.
- **Gaps are the deliverable.** Every field that can't map is logged with a
  severity, never silently dropped (PROVIDERS.md §10). `CONFORMANCE.md` is the
  primary artifact.

## Architecture

- `cli.ts` — `translate <Launchfile>` → writes `main.tf` + `CONFORMANCE.md`
- `translate.ts` — the core: `NormalizedLaunch` → Terraform document + a `Conformance` ledger
- `hcl.ts` — a tiny, pure, tested HCL emitter (blocks, attrs, strings, refs, heredocs)
- `gaps.ts` — the `Conformance` ledger + Markdown report rendering
- `conformance.ts` — sweeps spec examples + catalog apps → aggregate `CONFORMANCE.md`
- `logger.ts` — pino to stderr (translation is mostly pure, so logging is sparse)

## The two string worlds (hcl.ts)

This is the one subtle thing. A plain JS string is rendered as a **literal** —
`${...}` inside it is escaped to `$${...}` so Launchfile data can never inject a
Terraform interpolation. A `raw(...)` / `interp(...)` / `ref(...)` value is
emitted **verbatim** — that is how we deliberately reference AWS attributes and
build the interpolated connection strings that carry a resource's runtime
address into `env`. Mixing these up is how you'd either break refs or open an
injection. The `escapeString` replacements use **function** callbacks because a
string replacement would collapse `$$` back to `$`.

## Expression resolution

The provider populates the SDK `ResolverContext` with **Terraform interpolation
tokens** as values (e.g. `${aws_db_instance.x.address}`), then runs the SDK
`resolveExpression`. The same `$url` / `$app.url` / `$components.*` expression
therefore resolves to a live AWS reference, emitted via `interp()`.

## Testing

`bun test` (CI runs the providers under Bun's native runner) covers the HCL
emitter and the field-by-field mapping. **HCL validity is verified separately**
with `terraform validate` in CI — the unit tests assert structure, not schema
conformance. Locally you can validate with OpenTofu:

```bash
bun run src/cli.ts translate ../../spec/examples/multi-component.yaml --out /tmp/x
cd /tmp/x && tofu init -backend=false && tofu validate
```

## Dependencies

- `@launchfile/sdk` — parsing, normalization, expression resolution
- `pino` — structured logging
