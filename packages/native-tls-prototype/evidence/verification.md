# Verification record

Steward follow-up verified from `codex/demo-native-tls`. The branch includes the D-59 listener-definition documentation merge [bae761d4c562e703da959b733dfd432602a10a96](https://github.com/launchfile/launchfile/commit/bae761d4c562e703da959b733dfd432602a10a96); it changes no production code from the initial proof base. The live report records its own UTC execution timestamp.

The documentation follow-up on 2026-09-10 re-ran `bun run verify`: 115 tests passed on Bun 1.4.0 / Node.js 24.14.1, with the workspace SDK 0.7.0 and Docker provider 0.7.1 built first. No implementation changed in that follow-up. The seven-deployment proof remains the earlier recorded run preserved at [0a87583](https://github.com/launchfile/launchfile/commit/0a87583ec333dcf7dbbb7406f1fc47318f61dec7); it was not re-run for the documentation edit. These are manual verification records: no CI job runs this package.

| Check                  | Result                                          |
| ---------------------- | ----------------------------------------------- |
| `bun run verify`       | SDK/Docker builds, strict TypeScript, 115 tests |
| SDK `bun run test`     | 425 passed                                      |
| Docker `bun run test`  | 352 passed                                      |
| `bun run prove`        | Seven real Gitea deployments, 58 assertions     |
| Owned resource cleanup | Containers, volumes, proxies, temp files gone   |

The recorded [live proof](live-proof.json) uses `gitea/gitea:latest` resolved to `sha256:87a67ee09d3ae0d1df5fda5dcda3e2a1f9236a45b0a59025d6e00e46adc43bef`. It authenticates CA chains and hostnames, distinguishes edge/backend certificates, rejects bad trust/identity without plaintext fallback, preserves a data sentinel through all switches, and verifies Gitea's version endpoint plus Docker health. Certificate paths include a literal dollar sign to exercise Compose escaping. No system trust was installed.

The seven arrangements are HTTP, edge termination, native HTTPS, passthrough, re-encryption, native HTTPS on port 3443, and return to HTTP on port 3000. The supplying consumer rejects a client-authentication-only certificate before Docker starts; its separate verification helper uses [OpenSSL verify](https://docs.openssl.org/3.0/man1/openssl-verify/). Provider compilation does not call that helper or read certificate bytes. A test compiles nonexistent supplied paths successfully while retaining an explicitly unverified status; missing binding fields still refuse with a named error.

The revised tests cover `$listener.port` scope without changing resource-local `$port`, inactive malformed/shared bindings, retained expression transforms/escapes, and key-file redaction even with a registered vocabulary. Four catalog-derived candidate files preserve shipped dependency/storage/listener baselines and demonstrate documented wiring across five planned arrangements and changed native ports. Those are authoring/plan checks; only Gitea has live TLS deployment evidence. Existing SDK 425 and Docker 352 tests passed during the original extraction; neither production codebase changed in this follow-up.

The proof intentionally excludes public-HTTPS requirements and strictness; those are separate RFC demonstrations. This is not evidence of production-wide provider integration, general certificate lifecycle management, intermediate chains, multi-endpoint routing, or variants. See the package README for limits and commands.
