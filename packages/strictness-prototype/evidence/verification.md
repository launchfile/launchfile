# Verification evidence

Local checks on 2026-09-10 used Bun **1.4.0**, revision
`34cbb9a40b4bd1bd767d134a7065e66c2432a676`, on **Darwin arm64**.
`bun run verify` prints these runtime facts before building or testing.

From the repository root, `bun install --frozen-lockfile` passed with no changes.
From `packages/strictness-prototype`:

```sh
bun run verify
FORCE_COLOR=1 bun run verify
```

Both runs built SDK/Docker/AWS/macOS dependencies, passed strict TypeScript, and
passed **54 tests / 128 assertions**. The full forced-color run was also checked
with the caller's `NO_COLOR` unset to avoid Bun's conflicting-color-settings
warning. The subprocess regression itself always tests `FORCE_COLOR=0` and `1`
and removes `NO_COLOR` from those child environments. It compares the complete
stderr diagnostic after `stripVTControlCharacters`, while checking the original
stderr for the secret sentinel. ANSI formatting is tolerated; extra messages,
source excerpts, stacks, and secret leakage still fail the assertions.

The previously published head reproduced **53 passing tests / 1 failure** on
this runtime with forced color. That failure was the byte-exact stderr assertion,
not a sentinel leak. The new counts supersede the earlier environment-dependent
claim of 54 passing tests without runtime provenance.

The new `strictness-prototype` CI job runs on `macos-latest`, installs the frozen
lockfile, and invokes `bun run verify` with `FORCE_COLOR=1`. It uses the repository's
existing pinned checkout/setup-bun actions, reports the resolved runtime, and
does not start applications, containers, cloud resources, or Homebrew services.
Hosted execution is pending the PR update; the local result is not a hosted CI
result.

Workflow validation used **actionlint 1.7.12**. Its workflow/action/expression
validation passed with shellcheck integration disabled. Full actionlint reports
one inherited shellcheck SC2034 warning about the unused `i` variable in the
website readiness loop; the same warning reproduces on the unchanged base
workflow. The new job has no shellcheck finding. No unrelated workflow behavior
was changed.
