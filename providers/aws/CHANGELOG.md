# @launchfile/aws

## 0.2.0

### Minor Changes

- [#177](https://github.com/launchfile/launchfile/pull/177) [`ec18fcb`](https://github.com/launchfile/launchfile/commit/ec18fcb88be9549b10fca4091896e11d72c523c7) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `generator: secret` now emits the spec-defined output — 32 bytes of cryptographically random data, hex-encoded as 64 lowercase characters (D-47).
  
  **Both providers change observable output.** Neither emitted hex before: macos-dev produced 43 base64url characters, aws produced 32 alphanumeric characters. Both were already non-conforming to SPEC.md's shipped "cryptographically random hex string" wording.
  
  **`@launchfile/aws` — existing stacks rotate their secret.** The generated resource changes from `random_password` to `random_bytes`. Those are different Terraform resource types, so a `moved` block cannot bridge them and the next `terraform apply` will destroy and recreate. Any value encrypted at rest under the old secret — a Laravel `APP_KEY`, outline's `SECRET_KEY` — becomes undecryptable. **Back up or re-key before upgrading.**
  
  **`@launchfile/macos-dev` — the fix is not retroactive.** Generated secrets persist in `.launchfile/state.json` and are reused, so an existing deployment keeps its old value. This is deliberate (rotating a live secret on upgrade would be worse), but it means an app already deployed with a non-hex secret keeps it until that state is destroyed. This matters for `firefly-iii`, `monica` and `snipe-it`, whose `APP_KEY` is derived through `|base64` and requires exactly 32 bytes — they are broken on existing macos-dev deployments and stay broken until re-provisioned.

### Patch Changes

- Updated dependencies [[`c9404d9`](https://github.com/launchfile/launchfile/commit/c9404d9bce10d27fd67d5d74e0667459ea31a1aa), [`19ecdfc`](https://github.com/launchfile/launchfile/commit/19ecdfc864dadf5e436600e2d0637659225bcd47), [`7e8abc5`](https://github.com/launchfile/launchfile/commit/7e8abc56b4479f1f6cf587793004c33265c44f06), [`7e8abc5`](https://github.com/launchfile/launchfile/commit/7e8abc56b4479f1f6cf587793004c33265c44f06)]:
  - @launchfile/sdk@0.4.0

## 0.1.1

### Patch Changes

- Updated dependencies [[`6248fad`](https://github.com/launchfile/launchfile/commit/6248fadedb23ef08b4caa2e9bc4b60824ae0abfd)]:
  - @launchfile/sdk@0.3.0

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
