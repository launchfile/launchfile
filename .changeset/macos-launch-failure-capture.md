---
"@launchfile/macos-dev": minor
"@launchfile/sdk": minor
"launchfile": minor
"@launchfile/docker": patch
---

The macOS native provider now captures launch failures, so `launchfile diagnose` answers for `up --native` the way it already did for Docker (#44, part 2).

A failing native launch throws a `LaunchError` tagged with the D-48 slot it failed in — `prereq`, `resolve`, `parse`, `provision`, `prepare`, `release`, `run` — carrying the redacted command, exit code, output tails, and the component log tails from `.launchfile/logs/`. The CLI persists it and `launchfile diagnose` reads it back from another shell.

**Two failures that previously printed a message and exited now throw instead**: a missing prerequisite and a missing `Launchfile`. Both still print their original message and still exit 1, and they now leave a record. Because they travel through the CLI's top-level handler, stderr gains two more lines: a `Captured. Run launchfile diagnose for the full context.` hint, and an `Error:` restatement of the message. For a missing prerequisite, that restatement collapses the itemized list into one semicolon-joined line.

Records for a native launch are keyed by **project directory**, not by app name. The provider runs one instance per directory and refuses `--name`, so two checkouts of one app are two deployments and keep separate diagnoses. A successful `up` supersedes the record for that directory, and `down --destroy` removes it.

Values a Launchfile declares `sensitive: true` (D-18) and values an operator supplies for a `required:` variable (D-52) are now registered with the native provider's redactor before any command runs. Without that, the first thing this capture would have done is write a plaintext credential to disk (CWE-532).

`@launchfile/sdk` exports `sourceErrorKey`, the single derivation of a record key from a source string — the provider that writes a record and the CLI that later reads or clears it now share one implementation. `@launchfile/docker` keeps identical behaviour; its `dockerErrorKey` delegates to the shared helper.
