# @launchfile/sdk

## 0.1.8

### Patch Changes

- [`7ed1742`](https://github.com/launchfile/launchfile/commit/7ed174221a645ea3ba78fc289762b74726b3bfd1) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Removed `bin` entry from SDK package. The CLI binary now lives exclusively in the `launchfile` package — the SDK's leftover `bin` field was shadowing it, causing `npx launchfile up` to run the old SDK CLI instead.
