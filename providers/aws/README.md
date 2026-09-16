# @launchfile/aws

> **Status: Alpha.** The emitted HCL passes `terraform validate` against the real
> AWS provider schema, but the provider is **unproven against a live AWS account**
> and its output is **illustrative, not deployable as-is** (see
> [Known limitations](#known-limitations)). Expect breaking changes as the spec
> iterates. Published under the `alpha` npm dist-tag.

Translate a [Launchfile](https://launchfile.dev) into **Terraform** (EC2 + RDS + ALB).

This is a **translation-only** provider — a spec-conformance *probe*. It implements
exactly one verb, `translate`, and emits `.tf`. It never runs `terraform apply`,
never touches an AWS account, and never bills. Its purpose is to answer one
question with evidence: **does the same Launchfile map to AWS?**

```bash
npx @launchfile/aws translate ./Launchfile --out ./aws-out
#   → ./aws-out/main.tf          (the Terraform configuration)
#   → ./aws-out/CONFORMANCE.md   (what mapped, what gapped, what was ignored)
```

## Why it exists

Docker and macOS providers prove "same file → local runtime." This provider
stresses the spec against a **non-local, non-OCI** target to find where the
abstraction leaks (P-5, and RFC C / #78). The deliverable is the **conformance
report**, not a deployment.

## The mapping

| Launchfile | → Terraform / AWS | Notes |
|---|---|---|
| `runtime` + `commands.build`/`start` (no Dockerfile) | EC2 + cloud-init builds from source; `commands.start` → systemd unit | the portable-contract build path (RFC C) |
| `requires: postgres` / `mysql` | `aws_db_instance` (RDS) | intent → managed service, not a container (P-1/P-11) |
| `requires: redis` | `aws_elasticache_cluster` | same |
| `provides: { exposed: true }` | `aws_lb` (ALB) + target group + listener + security group | |
| `storage` | `aws_ebs_volume` + attachment | |
| `env` / `secrets` | `aws_ssm_parameter` (`SecureString` for sensitive) + `random_*` | 12-Factor III |
| `health.path` | ALB target-group `health_check` | |
| `depends_on` | Terraform `depends_on` | ordering |
| `build.dockerfile`/`target`/`args` | **ignored** (recorded, not errored) | RFC C — specialization never the sole build path |
| `source` / `install` / `dev` | **ignored** | provider is artifact-only (D-38) |

Anything that can't map is **logged as a gap**, never silently dropped
(PROVIDERS.md §10). See [`CONFORMANCE.md`](./CONFORMANCE.md) for the live report.

## Expression resolution

The provider supplies "home #3" values (D-36) as Terraform interpolations, so the
same `$`-expression resolves to a live AWS address:

- `$app.url` → `http://${aws_lb.main.dns_name}`
- `requires.postgres` `set_env: { DATABASE_URL: $url }` →
  `postgres://launchfile:${random_password…}@${aws_db_instance….address}:5432/<db>`
- `$components.<name>.url` → `http://${aws_instance.<name>.private_ip}:<port>`
- `$storage.<name>.path` → the declared mount path

## Minted secrets survive a re-translate

A `generator:` value is minted **once** and then preserved (D-49). In Terraform
the value lives in state under a resource's *type and name*, and no `moved` block
bridges a type change — so re-emitting the same secret as a different `random_*`
resource destroys it on the next `apply`. Anything encrypted under the old value
becomes unreadable.

So `translate` reads the output directory before it emits. It looks at
`terraform.tfstate`, then at the `main.tf` it wrote last time, and takes **only
resource types and names** — never a value, which is why no secret is ever
written into the generated HCL.

| What it finds | What it does |
|---|---|
| nothing — a fresh stack | mints under D-47: `random_bytes`, 32 bytes as 64 hex characters |
| the same resource type | emits it unchanged |
| a pre-D-47 `random_password` under a `generator: secret` | **preserves** it — keeps emitting `random_password`, so `plan` shows no diff and the deployed value survives. Reported as a gap in `CONFORMANCE.md`: the value is the old 32 alphanumeric characters, not the D-47 output |
| any other type change over a minted value | **refuses** — prints the app, the scope, the variable and the re-key steps, writes nothing, exits 1 |

`generator: port` is exempt, per D-49: a port is an allocation, not an identity.
The RDS master password is not `generator:` output either — it is a resource
credential (D-7) and is untouched by this rule.

To take the D-47 output on an existing stack, re-key deliberately: back up
anything encrypted under the current value, `terraform state rm` the resource,
re-translate, `apply`, then re-key the app.

## Conformance report

```bash
bun run conformance          # regenerate CONFORMANCE.md across spec examples + catalog
bun run conformance --check  # CI guard: fail if the report is stale
```

## Known limitations

This is an alpha **probe**, not a deployment tool. The output demonstrates the
mapping; it is not yet an applyable stack:

- **No IAM instance profile.** EC2 instances get no role, so they cannot read the
  `aws_ssm_parameter` values the translation creates — env is *modeled* but not
  *delivered*. A real `apply` would stand up infra, but the app wouldn't receive
  its environment. (Beta milestone: instance profile + an SSM-fetch in cloud-init.)
- **Source is assumed present.** The portable build path runs `commands.build` on
  EC2 against `/opt/app`, but a Launchfile carries no source location, so the
  clone/copy is out of band. This is itself a finding (see below).
- **cloud-init runtime installs are representative**, not production-hardened.
- **Validity ≠ deployability.** CI runs `terraform validate` (schema only). No
  `plan` or `apply` against a live account has been run.
- **Contract-limited catalog coverage.** ~73 of 83 catalog apps are image-only
  (no portable `runtime` + `commands`), so a non-OCI provider can build almost
  none of them from the contract. See [`CONFORMANCE.md`](./CONFORMANCE.md).

## Scope & non-goals

- **No `apply`, no teardown, no live AWS.** Reference translator + report only.
- Validity is checked in CI with `terraform validate` against the real AWS
  provider schema (no credentials required).
- This is **public** (`providers/aws`) and not commercial-moat material — that
  stays in `launchpad`/`experts`.

## Commands

```bash
bun install        # install dependencies
bun run build      # tsc → dist/
bun test           # unit tests (HCL emitter + translation mapping)
bun run typecheck  # tsc --noEmit
```

## License

MIT
