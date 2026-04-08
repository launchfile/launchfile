---
"launchfile": patch
"@launchfile/docker": patch
---

Added SDK public API re-exports to the `launchfile` package so `import { readLaunch, LaunchSchema } from "launchfile"` works as documented. CLI version is now read from package.json automatically.

Docker provider now resolves catalog slugs from the local directory during development, falling back to GitHub when published.
