---
"launchfile": patch
---

Stop compiling and publishing tests with the CLI. `packages/launchfile` built with plain `tsc`, so `src/__tests__/*.test.ts` landed in `dist/` and — via the `dist/**/*.js` files allowlist — in the npm tarball: 20 of `launchfile@0.7.0`'s 54 published files are compiled test artifacts. The same stale `dist/__tests__` tree also made Vitest collect every suite twice (20 files / 190 tests instead of 10 / 96), which is what pushed CI runs into the 5000ms default timeout. The package now builds with a `tsconfig.build.json` that excludes `src/**/__tests__/**`, matching `@launchfile/sdk` and both providers. No runtime behavior changes.
