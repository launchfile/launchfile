---
"@launchfile/sdk": minor
---

The `launchfile` CLI now refuses any unknown long flag (D-67, #636). Before, every flag it did not read was accepted and ignored with exit 0, so a typo such as `--jsonn` or `--detatched` silently changed nothing. The check runs once before any verb and before `--version`/`--help`: the CLI writes `Unknown flag: --<name>` to stderr, uncolored, and exits 1. It suggests a flag only on a single prefix or edit-distance-2 match, and strips control characters from the echoed token. `--schema-path` with no value, or followed by a `--` token, also exits 1. Single-dash tokens are not checked (#529).

**Breaking:** scripts that pass flags this CLI never read now fail instead of passing, and `--flag=value` on a boolean flag (`--json=false`, `--quiet=1`, `--version=x`) now exits 1 instead of being silently ignored. `launchfile --version` also now prints the version from `package.json` (it printed a hardcoded `0.1.2`).
