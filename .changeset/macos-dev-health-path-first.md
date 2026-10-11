---
"@launchfile/macos-dev": patch
"@launchfile/sdk": patch
---

A health block that declares both `path` and `command` now probes the `path`, as SPEC.md § health says. macos-dev used to run the `command` and, with no port allocated, report a `localhost:0` probe (#730). A declared empty `path` also counts as a path check. The SDK writer keeps a declared empty `path` when it serializes a health block. The docker provider got the same fix in #724.
