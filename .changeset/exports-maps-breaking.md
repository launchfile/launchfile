---
"@launchfile/docker": minor
"@launchfile/macos-dev": minor
"launchfile": minor
---

**Breaking:** `@launchfile/docker`, `@launchfile/macos-dev` and `launchfile` now declare an `exports` map that exposes only the package root. Deep imports such as `@launchfile/macos-dev/dist/provider.js` no longer resolve and fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Import from the package root instead: `import { ... } from "@launchfile/macos-dev"`. If you need something that the root does not export, open an issue asking for it to be made public. The map offers only the `import` condition, so load these packages with `import`, not CommonJS `require()`.
