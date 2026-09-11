---
"@launchfile/macos-dev": minor
---

`launchBootstrap({ reveal })` prints sensitive captures on the operator's explicit request, and every sensitive capture registers with the redactor at extraction (#464).

A bootstrap capture declared `sensitive: true` prints masked with a hint naming `launchfile bootstrap --reveal`; `reveal: true` prints the value. Masking is display only: the value is registered with the redactor before any result or printed line is built — also under `reveal` — so a failing command's stderr and every later diagnostic are scrubbed of it.
