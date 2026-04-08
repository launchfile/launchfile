# @launchfile/docker

## 0.1.8

### Patch Changes

- [`7ed1742`](https://github.com/launchfile/launchfile/commit/7ed174221a645ea3ba78fc289762b74726b3bfd1) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Added SDK public API re-exports to the `launchfile` package so `import { readLaunch, LaunchSchema } from "launchfile"` works as documented. CLI version is now read from package.json automatically.

  Docker provider now resolves catalog slugs from the local directory during development, falling back to GitHub when published.

- Updated dependencies [[`7ed1742`](https://github.com/launchfile/launchfile/commit/7ed174221a645ea3ba78fc289762b74726b3bfd1)]:
  - @launchfile/sdk@0.1.8
