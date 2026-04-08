# @launchfile/sdk

## 0.1.8

### Patch Changes

- [`ab08260`](https://github.com/launchfile/launchfile/commit/ab08260f963ebc44a54148398b8992b63919dbda) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Removed `bin` entry from SDK package. The CLI binary now lives exclusively in the `launchfile` package — the SDK's leftover `bin` field was shadowing it, causing `npx launchfile up` to run the old SDK CLI instead.
