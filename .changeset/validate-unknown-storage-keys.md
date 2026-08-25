---
"@launchfile/sdk": minor
---

`launchfile validate` warns when a storage entry carries keys the schema does not recognize (#239). Zod's default strip meant a typo like `persistant:` or a key from a newer spec vocabulary vanished silently — the entry validated, the intent was lost. The check runs on the raw document before parsing, names the unrecognized keys, and lists the known set so the fix is in the message. Warn-only per D-46's unknown-vocabulary posture: the exit code is unchanged, so no existing Launchfile starts failing validation.
