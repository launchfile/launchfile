# @launchfile/aws

## 0.1.0 — alpha

Initial release — a translation-only AWS provider (spec-conformance probe).
**Alpha:** emitted HCL passes `terraform validate`, but the provider is unproven
against a live AWS account and its output is illustrative, not deployable as-is
(no IAM instance profile to deliver SSM env; source assumed present on the
instance). Published under the `alpha` npm dist-tag.

- `translate` verb: Launchfile → Terraform (HCL) for EC2 + RDS + ALB.
- EC2 builds from the portable `runtime` + `commands` contract via cloud-init
  (no Dockerfile); `commands.start` becomes a systemd unit.
- `requires: postgres`/`mysql` → `aws_db_instance`; `requires: redis` →
  `aws_elasticache_cluster`; `provides.exposed` → ALB + target group + listener;
  `storage` → EBS; `env`/`secrets` → SSM Parameter Store + `random_*`.
- `build.dockerfile`/`target`/`args` recorded as ignored specializations (RFC C),
  not errors; source-mode fields ignored (artifact-only, D-38).
- Conformance reporting: every field is mapped, gapped, or ignored; aggregate
  `CONFORMANCE.md` generated across spec examples + catalog apps.
- No `apply` — validity proven by `terraform validate` in CI.
