# @launchfile/aws

## 0.6.2

### Patch Changes

- [#637](https://github.com/launchfile/launchfile/pull/637) [`39d9740`](https://github.com/launchfile/launchfile/commit/39d9740ea541db7be8e51efd5cdd5c9fad30c7fb) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - `launchfile-aws` now refuses, before anything runs, an argument it does not
  read — on stderr, exit 1, nothing written ([D-67] shape, [#528](https://github.com/launchfile/launchfile/issues/528)). It used to
  read its two flags by position and drop the rest: `translate app --regoin
  eu-north-1` wrote a `main.tf` for the default region with nothing to say so,
  `--region` as the last token fell through to the default the same way,
  `launchfile-aws deploy app` printed usage and exited 0, and `translate --out
  dir app` tried to open a file named `--out`. The operator's next step after
  each is `terraform apply`.
  
  Refused now:
  
  - an unknown `--` flag: `no such flag --regoin`, with the known flags listed
    (`--out, --region, --rekey, --help`); a bare `--` has its own message
  - `--out`, `--region` or `--rekey` with no value, or written `--flag=value`
  - any verb but `translate` — `Unknown command: deploy`, exit 1
  - a `--` token where the command belongs, a second Launchfile path, or a
    single-value flag given twice
  
  Exit 0 is kept for a bare invocation and `--help` only. `--help` counts only
  where a flag stands, never as the value after `--out`, `--region` or
  `--rekey`. `translate` with no Launchfile path now prints its refusal on
  stderr instead of usage on stdout; its exit code (1) is unchanged. The
  Launchfile path is the first non-flag token, so flags may sit on either side
  of it.
  
  A script that passed a stray or typo'd flag, or a verb other than
  `translate`, and relied on exit 0 now fails. Single-dash tokens are unchanged
  ([#529](https://github.com/launchfile/launchfile/issues/529)).

- [#723](https://github.com/launchfile/launchfile/pull/723) [`277cde2`](https://github.com/launchfile/launchfile/commit/277cde2804089006c845612ee8939e8ccb377dc4) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - A component whose `health` block declares only `command` no longer has its `/` ALB health check recorded as mapped ([#718](https://github.com/launchfile/launchfile/issues/718)). The probe now records a `workaround` conformance gap for `health`; the target group keeps its `/` probe with the `200-399` matcher. Every other `health` block, including one with only `start_period`, is mapped, and `health.path` is used as before.

- [#701](https://github.com/launchfile/launchfile/pull/701) [`dca274b`](https://github.com/launchfile/launchfile/commit/dca274b2de2d359aad3d785f82296783c59a1dd1) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - Report a `requires[].version` range a provider cannot show is met, in every reference provider ([#404](https://github.com/launchfile/launchfile/issues/404), D-74). `@launchfile/sdk` exports `checkVersionRange(declared, provided)`, the one range comparison all three providers use: it classifies a declared node-semver range against the version or version family a provider runs as `satisfied`, `unsatisfied`, `undecidable`, `unknown` or `invalid`. `semver` moves from `@launchfile/docker` to `@launchfile/sdk`.
  
  `@launchfile/docker` now calls the shared comparison. Its warnings are unchanged.
  
  `@launchfile/macos-dev` read no `requires[].version` at all. Each resource provisioner now returns `warnings`, and `up` prints them. Postgres, MySQL/MariaDB and Redis ask the running server for its version and compare the range with it; a satisfied range is silent. A `mariadb` range is compared only against a MariaDB server. A `sqlite` range always warns, because the provider creates the file and supplies no SQLite library.
  
  `@launchfile/aws` built `engine_version` by deleting every non-digit from the range, and fell back to `"16"` when nothing was left: `>=9.6` became an exact `9.6`, `^7.0` became `7.0`, `20.x` became `20.`. It now passes a bare dotted version of one to three parts (`16`, `16.4`, `8.0.35`) through unchanged as `engine_version`, emits no `engine_version` for any other range, and records a `requires:<name>.version` workaround gap. This covers postgres, mysql and mariadb. ElastiCache redis ranges are compared with the Redis 7 family its `default.redis7` parameter group fixes. `catalog/apps/hedgedoc` (`>=9.6`) no longer gets a pin to the retired RDS PostgreSQL 9.6. Instead it records the gap in `CONFORMANCE.md`.
- Updated dependencies [[`2aa8017`](https://github.com/launchfile/launchfile/commit/2aa8017966832aa0f1e4ecd603349fa67089ea1f), [`6c27a10`](https://github.com/launchfile/launchfile/commit/6c27a108527fc46156805493c4986ec3fa04d631), [`e13e0c6`](https://github.com/launchfile/launchfile/commit/e13e0c621a03ac177e790d745eb6643e6310bfb0), [`891688d`](https://github.com/launchfile/launchfile/commit/891688d91926851403994b0c35c4237709bb2662), [`dca274b`](https://github.com/launchfile/launchfile/commit/dca274b2de2d359aad3d785f82296783c59a1dd1), [`420eca8`](https://github.com/launchfile/launchfile/commit/420eca84b4294623fcf33f477b8ace9ee2733dd5), [`10e7262`](https://github.com/launchfile/launchfile/commit/10e7262cf254816e233e5fde1f1f0bab9c47b2c4), [`11efd8d`](https://github.com/launchfile/launchfile/commit/11efd8dd1fb8bfd429c8a829642bc1e6c45cc913), [`4143948`](https://github.com/launchfile/launchfile/commit/414394866633a2c6f7f829d9ea4c8e460732fe5c)]:
  - @launchfile/sdk@0.15.0

## 0.6.1

### Patch Changes

- [#648](https://github.com/launchfile/launchfile/pull/648) [`b208f9c`](https://github.com/launchfile/launchfile/commit/b208f9cf07862eccf684bce118358d92077543fc) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - The conformance report now opens with a gap-severity legend ([#592](https://github.com/launchfile/launchfile/issues/592)). It defines 🔴 `blocker`, 🟡 `workaround` and 🟢 `nice-to-have` in terms of this probe, and states that a gap of any severity never stops `translate()`. The icons come from the same map the report rows use.
- Updated dependencies [[`6ec891b`](https://github.com/launchfile/launchfile/commit/6ec891bdfea097e436eb4c68f7dfe0d491830c22), [`3632d48`](https://github.com/launchfile/launchfile/commit/3632d48ba09532cdf11908dbb23103c5a2a07a57), [`91ca1a8`](https://github.com/launchfile/launchfile/commit/91ca1a84acfcfca20bcd4ba0c73e6fd5492b7692), [`dff6745`](https://github.com/launchfile/launchfile/commit/dff67458457392e6d9b6ab15a2651ebbc2dbb412), [`2c7d895`](https://github.com/launchfile/launchfile/commit/2c7d895ea3033f77857b8458c0d095a111787f5e)]:
  - @launchfile/sdk@0.14.0

## 0.6.0

### Minor Changes

- [#433](https://github.com/launchfile/launchfile/pull/433) [`e1256dd`](https://github.com/launchfile/launchfile/commit/e1256dd4caec1488668fa7caebd732395b4362ec) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `translate` now preserves a secret that was already minted, instead of rotating it.
  
  The D-47 conformance change (0.2.0) swapped the generated resource from
  `random_password` to `random_bytes`. Those are different Terraform resource
  types, a `moved` block cannot bridge them, and the next `terraform apply`
  destroyed and recreated the secret — anything encrypted under the old value
  became unreadable. The release notes warned about it; nothing stopped it.
  
  `translate` now reads the output directory before it emits — `terraform.tfstate`
  whenever it parses, even one that `terraform state rm` has emptied, and only when
  there is no state file at all the `main.tf` it wrote last time — and takes
  **only resource types and names** from it, never a value. A state file that
  exists but does not parse as Terraform state — broken JSON, or JSON without the
  v4 state shape (`version: 4`, an integer `serial`, a non-empty `lineage`, and a
  `resources` array of objects; `{}`, `{"version":4,"resources":[]}` and a legacy
  v3 state all fail it) — is refused, exit 1, nothing written: it proves the stack is not fresh and says
  nothing about what is minted, and `main.tf` is not read in its place. The
  refusal names the file and the way forward (repair or restore it, or remove it
  deliberately).
  
  - **Nothing there** (a fresh stack): mints under D-47, unchanged — `random_bytes`,
    32 bytes as 64 lowercase hex characters.
  - **A pre-D-47 `random_password`** under a `generator: secret`: preserved. The
    provider keeps emitting `random_password`, so `terraform plan` reports no
    change and the deployed value survives. `CONFORMANCE.md` records the gap: that
    value is the old 32 alphanumeric characters, not the D-47 output.
  - **Any other resource-type change over a minted value**: refused. The CLI prints
    the app, the scope, the variable and the re-key steps for every conflicting
    secret at once, writes nothing, and exits 1.
  
  `generator: port` is exempt (D-49 — a port is an allocation, not an identity),
  and the RDS master password is untouched: it is a resource credential (D-7), not
  `generator:` output.
  
  To take the D-47 output on an existing stack, re-key deliberately: back up
  anything encrypted under the current value, `terraform state rm` the resource,
  re-translate, apply, then re-key the app. When the record came from `main.tf`
  (no state file in the output directory), re-translate with the new
  `--rekey <random_type>.<name>` flag — `state rm` never touches `main.tf`, and
  `--rekey` drops exactly that record while every other minted secret stays
  preserved (or refused). An address the record does not hold is refused, and so
  is a `--rekey` with no value or in the `--rekey=<address>` form. The
  refusal and the `CONFORMANCE.md` gap name the file they read and print the
  steps, with the addresses, for it.

### Patch Changes

- Updated dependencies [[`95df039`](https://github.com/launchfile/launchfile/commit/95df0392bdf474842cca95e6d9715c13a21e7c64)]:
  - @launchfile/sdk@0.13.0

## 0.5.0

### Minor Changes

- [#549](https://github.com/launchfile/launchfile/pull/549) [`036fac1`](https://github.com/launchfile/launchfile/commit/036fac13ecd17b56982710ce15d74ad6c6569bbe) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Report a `provides` entry that declares `at:` unmapped on `translate` ([#547](https://github.com/launchfile/launchfile/issues/547), D-68 rule 5, PROVIDERS.md §10 items 5 and 8).
  
  A provider sets up the names a published entry declares or reports each one it did not set up. This probe emits one ALB default action per listener, which forwards every host name to it, and no DNS record, host-header rule or certificate. Nothing is launched on `translate`, so each declaring entry is listed as a `provides.at` gap on its component, at severity `workaround`, naming the entry and every declared value: an operator can add the records by hand.
  
  The HCL and the rest of the ledger are identical for every Launchfile that declares no `at:`.

### Patch Changes

- Updated dependencies [[`036fac1`](https://github.com/launchfile/launchfile/commit/036fac13ecd17b56982710ce15d74ad6c6569bbe)]:
  - @launchfile/sdk@0.12.0

## 0.4.0

### Minor Changes

- [#400](https://github.com/launchfile/launchfile/pull/400) [`abf6852`](https://github.com/launchfile/launchfile/commit/abf68525f653f9fd4f369e35661de5d452b857aa) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Make the documented `$components.<component>.<endpoint>.<property>` form resolve, and stop an unknown endpoint name resolving to the wrong port.
  
  SPEC.md has listed the four-segment named-endpoint form since D-6 gave `provides` entries a `name`, but no provider registered anything under those names — every provider built one flat `{url, host, port}` record per component from `provides[0]`. The reference did not merely fail: `resolveComponentPath` missed the `<endpoint>.<property>` key and fell back to the last path segment alone, so `$components.web.https.port` answered with the *first* endpoint's port. A sibling wired itself to a live, plausible, wrong port with nothing reported.
  
  - `@launchfile/sdk`: the `components.*` lookup no longer falls back to the last path segment — an endpoint name nobody registered resolves to the empty string (L-4), or to a `${...:-default}`. New `endpointProperties(provides, host)` export builds the flat `<endpoint>.host` / `.port` / `.protocol` (and `.url` when the protocol names a URL scheme) keys a provider registers — from the effective listener when it is handed the active certificate set (D-61); three-segment references such as `$components.backend.url` are unchanged.
  - `@launchfile/docker`, `@launchfile/aws`: register those keys for every declared endpoint at the sibling's in-network address, independent of D-27 publication — `exposed` governs the host boundary, not visibility between siblings. On docker, `<endpoint>.protocol` and `<endpoint>.url` read the effective listener (D-61): an endpoint whose certificate binding is active says `https`, as `$components.<name>.url` already does.
  - `@launchfile/macos-dev`: `buildResolverContext` takes the declared components as an optional seventh argument (after the `$app.endpoints` map and the declared uses) and registers the same keys. This provider allocates one host port per component; when the allocator has moved a component off every port it declares, no declared endpoint can be named at that port, so the component registers its primary keys only.

### Patch Changes

- Updated dependencies [[`abf6852`](https://github.com/launchfile/launchfile/commit/abf68525f653f9fd4f369e35661de5d452b857aa)]:
  - @launchfile/sdk@0.11.0

## 0.3.2

### Patch Changes

- [#488](https://github.com/launchfile/launchfile/pull/488) [`ab3e359`](https://github.com/launchfile/launchfile/commit/ab3e359e70f00fe9758855b33cc99506e1736dc2) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `$app.endpoints.<name>.*` resolves `""` for every property on this provider, and `translate` reports it ([#463](https://github.com/launchfile/launchfile/issues/463), D-63 rule 4, [#487](https://github.com/launchfile/launchfile/issues/487)).
  
  The probe fronts one load-balancer address and publishes nothing per endpoint, so every per-endpoint property is `""` — the primary's included — while `$app.*` keeps the ALB value. Each endpoint the file references lands on the conformance report as a `workaround` gap naming the component.

- [#491](https://github.com/launchfile/launchfile/pull/491) [`af1ea04`](https://github.com/launchfile/launchfile/commit/af1ea04b61da951a9171b0d34b627e5505015b3b) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Carry an author-declared `restart:` onto the generated systemd unit. `translate` never read `component.restart` and wrote `Restart=always` into every unit, so a component declaring `restart: "no"` or `restart: on-failure` got an artifact that contradicts the file it was translated from — and the conformance ledger, which promises every field is mapped, gapped, or safely ignored, never mentioned the field at all. The three Launchfile values now map through an explicit table onto `Restart=always`, `Restart=on-failure`, and `Restart=no`, and the mapping is recorded on the ledger. A component that declares no `restart:` still gets `Restart=always`, now as a stated default; the cross-provider default for an undeclared `restart:` is decided in [#234](https://github.com/launchfile/launchfile/issues/234).
- Updated dependencies [[`ab3e359`](https://github.com/launchfile/launchfile/commit/ab3e359e70f00fe9758855b33cc99506e1736dc2), [`f40e7b6`](https://github.com/launchfile/launchfile/commit/f40e7b68d99f61d777455f0f79e4ab94d2cf1519), [`3587317`](https://github.com/launchfile/launchfile/commit/35873173251a6a8e9f97d5fae592fa7fd998bf7d), [`31dbac2`](https://github.com/launchfile/launchfile/commit/31dbac2a4c58dc50c4d4959facf6ff0b3aefa1e3), [`1123da3`](https://github.com/launchfile/launchfile/commit/1123da37959a0fbebca27c112ed6e8ebd8dc0bff), [`d2039b2`](https://github.com/launchfile/launchfile/commit/d2039b22ce1ed3fb5fc2fb7f2cb427d3582e4269), [`1796de9`](https://github.com/launchfile/launchfile/commit/1796de9ae8d42f920cca6a4326de9e2ed981fe2f), [`39df9db`](https://github.com/launchfile/launchfile/commit/39df9db10c64b7fded71e9afd74c08c7a8614285), [`a399ba3`](https://github.com/launchfile/launchfile/commit/a399ba365a2c7a3fe3b349d43810d3ff329e77c2)]:
  - @launchfile/sdk@0.10.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`b5022ae`](https://github.com/launchfile/launchfile/commit/b5022aed608e2ccd65857fb9a045337faeb94830)]:
  - @launchfile/sdk@0.9.0

## 0.3.0

### Minor Changes

- [#468](https://github.com/launchfile/launchfile/pull/468) [`fc92434`](https://github.com/launchfile/launchfile/commit/fc9243433293ac0c2061d25f6c83b352985c023f) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Report a `certificate` entry unmapped on `translate` (D-61 rule 5, PROVIDERS.md §10 items 5 and 8).
  
  A certificate activates the app's **own** listener, and this probe has no way to place one inside the task; on `translate` there is no launch at which to refuse, so the entry is listed as a nice-to-have gap naming the listener it binds and the certificate entry. Terminating TLS at the ALB is a different arrangement and does not fulfil the entry (D-61 rule 4), so nothing is emitted that would make the declaration look satisfied.

- [#465](https://github.com/launchfile/launchfile/pull/465) [`dc8a759`](https://github.com/launchfile/launchfile/commit/dc8a75968f56be9811d9feda38ceb640e453be9b) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Report an `https-origin` entry as unmapped on `translate`, with a reason that names the endpoint (D-60 rule 5).
  
  This probe composes `$app.*` from the ALB's `${aws_lb.main.dns_name}` — an http-only address that does not exist until apply time — so no managed service maps the entry. A `requires:` entry is now a **blocker** gap suggesting an ACM certificate and an HTTPS listener; a `supports:` entry is **nice-to-have**. Previously it fell through the generic "no managed AWS service mapping" branch, which graded a whole-app HTTPS requirement as a workaround.

### Patch Changes

- Updated dependencies [[`fc92434`](https://github.com/launchfile/launchfile/commit/fc9243433293ac0c2061d25f6c83b352985c023f), [`dc8a759`](https://github.com/launchfile/launchfile/commit/dc8a75968f56be9811d9feda38ceb640e453be9b)]:
  - @launchfile/sdk@0.8.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`78e654d`](https://github.com/launchfile/launchfile/commit/78e654dee040d6eb2e1aa18bb850b219de777996)]:
  - @launchfile/sdk@0.7.0

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
