# Verification record

Verified on 2026-09-09 from `codex/demo-native-tls`, based on public commit [093983b214473c2a188cebeb0d31bfdf31498664](https://github.com/launchfile/launchfile/commit/093983b214473c2a188cebeb0d31bfdf31498664).

| Check                      | Result                                        |
| -------------------------- | --------------------------------------------- |
| `bun run verify`            | SDK/Docker builds, strict TypeScript, 89 tests |
| SDK `bun run test`          | 425 passed                                    |
| Docker `bun run test`       | 352 passed                                    |
| `bun run prove`             | Seven real Gitea deployments, 58 assertions    |
| Owned resource cleanup     | Containers, volumes, proxies, temp files gone  |

The recorded [live proof](live-proof.json) uses `gitea/gitea:latest` resolved to `sha256:87a67ee09d3ae0d1df5fda5dcda3e2a1f9236a45b0a59025d6e00e46adc43bef`. It authenticates CA chains and hostnames, distinguishes edge/backend certificates, rejects bad trust/identity without plaintext fallback, preserves a data sentinel through all switches, and verifies Gitea's version endpoint plus Docker health. Certificate paths include a literal dollar sign to exercise Compose escaping. No system trust was installed.

The seven arrangements are HTTP, edge termination, native HTTPS, passthrough, re-encryption, native HTTPS on port 3443, and return to HTTP on port 3000. The final test suite additionally checks refusal of a partial app when any component is skipped, preservation of required-environment failures, and secret-safe parse diagnostics. The live proof now also refuses a client-authentication-only certificate before Docker starts; certificate-purpose verification uses [OpenSSL verify](https://docs.openssl.org/3.0/man1/openssl-verify/).

The proof intentionally excludes public-HTTPS requirements and strictness; those are separate RFC demonstrations. This is not evidence of production-wide provider integration, general certificate lifecycle management, intermediate chains, multi-endpoint routing, or variants. See the package README for limits and commands.
