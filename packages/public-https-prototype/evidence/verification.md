# Verification

Executed locally on 2026-09-09 in the isolated `codex/demo-public-https` worktree:

- `bun run verify`: SDK build, strict TypeScript, and 69 tests across planner, authenticated route probe, and CLI passed.
- `bun run prove`: all 12 checks passed; [live-proof.json](live-proof.json) records the actual run.
- The authenticated loopback proof and tests exercised Bun and Vitest's Node runtime respectively. Bun 1.4.0, TypeScript 7.0.2, and Vitest 5.0.0 were used.
- CLI tests confirmed that malformed YAML and schema errors do not echo a secret sentinel. Only plan metadata is printed on success.
- Listener/probe tests verified that owned servers, sockets, and temporary PKI files were removed. No external services or trust stores were changed.

The report's loopback origin, timestamp, and certificate fingerprint are disposable execution evidence. That endpoint is stopped after the proof and is not a service for reviewers to visit. Rerun the package's `prove` script to reproduce with fresh ports and certificates.

No production SDK/provider behavior was changed or claimed to be covered by this demonstration's tests. It validates the proposal boundary using an in-process fixture, not a full deployment or catalog app.
