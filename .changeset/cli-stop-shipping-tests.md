---
"launchfile": patch
---

Stop compiling and publishing tests with the CLI. `packages/launchfile` built with plain `tsc`, so `src/__tests__/*.test.ts` landed in `dist/` and — via the `dist/**/*.js` files allowlist — in the npm tarball: 20 of `launchfile@0.7.0`'s 54 published files are compiled test artifacts. That same `dist/__tests__` tree also made Vitest collect every suite twice (20 test files instead of 10), doubling the work each CI run does. The package now builds with a `tsconfig.build.json` that excludes `src/**/__tests__/**` — byte-for-byte the config `@launchfile/docker` and `@launchfile/macos-dev` use, while `@launchfile/sdk` and `@launchfile/aws` build the same way with their own exclude lists. No runtime behavior changes.
