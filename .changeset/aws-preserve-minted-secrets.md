---
"@launchfile/aws": minor
---

`translate` now preserves a secret that was already minted, instead of rotating it.

The D-47 conformance change (0.2.0) swapped the generated resource from
`random_password` to `random_bytes`. Those are different Terraform resource
types, a `moved` block cannot bridge them, and the next `terraform apply`
destroyed and recreated the secret — anything encrypted under the old value
became unreadable. The release notes warned about it; nothing stopped it.

`translate` now reads the output directory before it emits — `terraform.tfstate`
first, then the `main.tf` it wrote last time — and takes **only resource types
and names** from it, never a value.

- **Nothing there** (a fresh stack): mints under D-47, unchanged — `random_bytes`,
  32 bytes as 64 lowercase hex characters.
- **A pre-D-47 `random_password`** under a `generator: secret`: preserved. The
  provider keeps emitting `random_password`, so `terraform plan` reports no
  change and the deployed value survives. `CONFORMANCE.md` records the gap: that
  value is the old 32 alphanumeric characters, not the D-47 output.
- **Any other resource-type change over a minted value**: refused. The CLI prints
  the app, the scope, the variable and the re-key steps, writes nothing, and
  exits 1.

`generator: port` is exempt (D-49 — a port is an allocation, not an identity),
and the RDS master password is untouched: it is a resource credential (D-7), not
`generator:` output.

To take the D-47 output on an existing stack, re-key deliberately: back up
anything encrypted under the current value, `terraform state rm` the resource,
re-translate, apply, then re-key the app.
