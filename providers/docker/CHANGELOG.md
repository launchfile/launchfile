# @launchfile/docker

## 0.1.10

### Patch Changes

- [`d0298ba`](https://github.com/launchfile/launchfile/commit/d0298ba3e630087613e9b6a2ce63e0ba649f9d7d) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Fixed missing dist/ in Docker provider and SDK packages published in 0.1.8.

- Updated dependencies [[`d0298ba`](https://github.com/launchfile/launchfile/commit/d0298ba3e630087613e9b6a2ce63e0ba649f9d7d)]:
  - @launchfile/sdk@0.1.10

## 0.1.8

### Patch Changes

- [`ab08260`](https://github.com/launchfile/launchfile/commit/ab08260f963ebc44a54148398b8992b63919dbda) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Added SDK public API re-exports to the `launchfile` package so `import { readLaunch, LaunchSchema } from "launchfile"` works as documented. CLI version is now read from package.json automatically.

  Docker provider now resolves catalog slugs from the local directory during development, falling back to GitHub when published.

- Updated dependencies [[`ab08260`](https://github.com/launchfile/launchfile/commit/ab08260f963ebc44a54148398b8992b63919dbda)]:
  - @launchfile/sdk@0.1.8
