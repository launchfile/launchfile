# AWS translator — a spec-conformance probe

> **Status:** draft scoping doc for review. **Home:** public `providers/aws` (translation-only). **Purpose:** stress P-5 (provider-translatable) and RFC C (#78, contract vs specialization) with a non-local, non-OCI target. Designed to **find gaps**, not to deploy.

## Approach

Launchfile → **Terraform (HCL)** for **EC2 + RDS + ALB**. No `apply`. Conformance signal from `terraform validate` (always, offline); optional `terraform plan` behind a creds flag (still no apply). No live AWS account needed for the core signal.

## The mapping (this table *is* the probe)

| Launchfile | Terraform / AWS | What it tests |
|---|---|---|
| `runtime` + `commands.build`/`install`, **no Dockerfile** | EC2 cloud-init builds from source (buildpack/runtime) | RFC C contract path — **non-OCI build** |
| `commands.start` | systemd unit | run slot, artifact mode |
| `requires: postgres` | `aws_db_instance` (RDS) | **P-1/P-11 marquee**: intent → managed service, not a container |
| `requires: redis` | `aws_elasticache_cluster` | same |
| `provides: {port, exposed}` | ALB + target group + security group | provides → network |
| `storage` | EBS volume | persistence |
| `env` / `secrets` | SSM Parameter Store / Secrets Manager | 12-Factor III |
| `health` | ALB/target health check | health mapping |
| `depends_on` | Terraform ordering | ordering |
| execution mode | **artifact-only** (no `dev`/source) | #77 mode-per-provider |
| `build.dockerfile`/`target`/`args` | **ignored** | RFC C — specialization ignored safely, contract suffices |

## What it validates

- **P-5**: same file → AWS IaC. Every field that *can't* map is a logged gap (GAPS.md-style report) — the deliverable, not a failure.
- **RFC C (#78)**: builds with **no Dockerfile** (contract suffices); the Dockerfile hint is ignored, not errored — proving "never the sole build path."
- **#77**: a cloud provider is artifact-only, and a third provider implements the prepare/run slot interface — validating the taxonomy beyond docker/macos.
- **Cross-invocation state note**: forces the question of what a non-local provider must publish (published vs internal addresses) — feeds the vantage model directly.

## Scope / non-goals

- No `apply`, no teardown, no live RDS. Reference translator + conformance report only.
- Public (`providers/aws`) — a "same file → AWS Terraform" artifact is a credibility win for P-5; **not** commercial-moat material (that stays in launchpad/experts).

## Deliverables

- `providers/aws/src/translate.ts` (Launchfile → HCL)
- a conformance report (mapped vs gapped fields, per catalog example)
- CI: `terraform validate` on HCL emitted from the spec examples / catalog.

## Sequence

After/alongside the cross-invocation state note — it pressures what the registry must hold for non-local providers, so a little overlap sharpens both.
