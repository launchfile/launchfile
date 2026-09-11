---
"@launchfile/sdk": minor
---

`formatCaptures(captures, captureMeta, reveal)` — the one display formatter for a command's captures (#464).

A capture declared `sensitive: true` prints as `***` on every display surface unless `reveal` is true, and a masked list ends with one hint line naming `launchfile bootstrap --reveal`. Non-sensitive captures print the same either way. `sensitiveCaptureValues` returns the values a provider must register with its redactor. The SDK returns lines; the provider prints them. `CAPTURE_MASK` and `REVEAL_HINT` are exported so tests and providers agree on the text.
