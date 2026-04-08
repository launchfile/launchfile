# launchfile

## 0.1.9

### Patch Changes

- [`cfc48c1`](https://github.com/launchfile/launchfile/commit/cfc48c1f2ace3074c14252127b44f9c3b2f93a55) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Fixed missing dist/ in published package — CLI binary was not included in 0.1.8.

## 0.1.8

### Patch Changes

- [`ab08260`](https://github.com/launchfile/launchfile/commit/ab08260f963ebc44a54148398b8992b63919dbda) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Added SDK public API re-exports to the `launchfile` package so `import { readLaunch, LaunchSchema } from "launchfile"` works as documented. CLI version is now read from package.json automatically.

  Docker provider now resolves catalog slugs from the local directory during development, falling back to GitHub when published.

- Updated dependencies [[`ab08260`](https://github.com/launchfile/launchfile/commit/ab08260f963ebc44a54148398b8992b63919dbda), [`ab08260`](https://github.com/launchfile/launchfile/commit/ab08260f963ebc44a54148398b8992b63919dbda)]:
  - @launchfile/sdk@0.1.8
  - @launchfile/docker@0.1.8
