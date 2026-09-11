# Verification

Executed locally on 2026-09-09 in the isolated `codex/demo-public-https` worktree:

- `bun run verify`: SDK build, strict TypeScript, and 92 tests across planner, authenticated route probe, and CLI passed.
- `bun run prove`: all 16 checks passed; [live-proof.json](live-proof.json) records the actual run, including no-channel, after-apply, missing-publication, and translation-only outcomes.
- `bun run census`: 113 catalog files (72 apps, 41 drafts), two reviewed browser-origin motivations and one explicit counterexample; edited Vaultwarden Launchfile validates with the current SDK. [census.json](census.json) records the run.
- The authenticated loopback proof and tests exercised Bun and Vitest's Node runtime respectively. Bun 1.4.0, TypeScript 7.0.2, and Vitest 5.0.0 were used.
- CLI tests confirmed that malformed YAML and schema errors do not echo a secret sentinel. Only plan metadata is printed on success.
- Listener/probe tests verified that owned servers, sockets, and temporary PKI files were removed. No external services or trust stores were changed.

The report's loopback origin, timestamp, and certificate fingerprint are disposable execution evidence. That endpoint is stopped after the proof and is not a service for reviewers to visit. Rerun the package's `prove` script to reproduce with fresh ports and certificates.

No production SDK/provider behavior was changed or claimed to be covered by this demonstration's tests. It validates the proposal boundary using an in-process fixture, not a full deployment or catalog app. The catalog edit changes a description only; no new declaration or deployment test is claimed.

## PR review follow-up, 2026-09-10

The first-exposed endpoint heuristic is now explicitly a prototype scope choice, not a D-58 definition or rule for app declarations. Only comment, naming, diagnostic, test-expectation and documentation changes were made; endpoint selection, reporting, probe and cleanup logic are unchanged. `bun run verify` was rerun for this follow-up (SDK build, strict TypeScript, 92 tests). The 16-check live proof and census above remain the dated 2026-09-09 observations; they are not presented as new runs.

Existing repository CI has no step that typechecks/tests this private package or runs its proof. Workspace dependency installation is not package verification. The results above are local evidence, independent of the PR's repository-wide check list.
