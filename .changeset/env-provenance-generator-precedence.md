---
"@launchfile/macos-dev": minor
---

A declared `generator:` now outranks a declared `default:` when both appear on the same env var (D-49 provenance precedence).

Previously `resolveComponentEnv` filled the default first and `resolveGenerators` skipped any key already set, so this provider resolved to the literal where `@launchfile/docker` and `@launchfile/aws` minted a value — the same file producing two different answers.

No shipped catalog app declares both fields on one variable, so no published Launchfile changes behavior.
