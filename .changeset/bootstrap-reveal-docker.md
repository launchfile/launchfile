---
"@launchfile/docker": minor
---

`dockerBootstrap({ reveal })` prints sensitive captures on the operator's explicit request, and every sensitive capture registers with the redactor at extraction (#464).

A bootstrap capture declared `sensitive: true` prints masked with a hint naming `launchfile bootstrap --reveal`; `reveal: true` prints the value. Masking is display only: the value is registered with the redactor before any result, failure record, or log line is built — also under `reveal` — so a bootstrap that fails after producing the value no longer carries it raw into the record `launchfile diagnose` prints. Each bootstrap command now leaves one debug log line (component, exit code, captured keys, scrubbed stderr on failure). `release` captures use the same formatter, always masked, and register the same way.
