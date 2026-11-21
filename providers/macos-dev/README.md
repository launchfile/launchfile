# @launchfile/macos-dev

Run a [Launchfile](https://launchfile.dev) app natively on macOS for local development.

This package is the native provider behind the `launchfile` CLI. Most people use it through the CLI and never import it:

```bash
npx launchfile up --native     # run the Launchfile in this directory natively
npx launchfile dev             # run from source (install, then dev)
npx launchfile down            # stop what up started
```

## What it does

- Runs apps from source. It ignores `image:` and uses `runtime:` with native toolchains: node via fnm, python via pyenv, ruby via rbenv, bun via Homebrew.
- Provides `requires:` databases (postgres, mysql, redis and others) as shared Homebrew services, with one database per app, namespaced by the app name.
- Runs source-mode commands (D-38): `install` (or `build`) to prepare, and `dev` over `start` to run. The prepare step runs on the first launch and again only when the command or a dependency manifest or lockfile changes.
- Skips optional `supports:` resources by default. Pass `withOptional: true` to `launchUp` to provide them.

Commands run natively with your user's privileges, so use this provider for local, trusted sources. For an untrusted source, use [`@launchfile/docker`](https://www.npmjs.com/package/@launchfile/docker), which builds inside a container.

## Timeout defaults

Used when a command declares no `timeout:` ([PROVIDERS.md §10](https://github.com/launchfile/launchfile/blob/main/spec/PROVIDERS.md)):

| Command                        | Default |
|--------------------------------|---------|
| prepare (`install` ?? `build`) | 10m     |
| `release`                      | 2m      |
| `bootstrap`                    | 2m      |
| health gate (per component)    | `retries × (interval + timeout)` when `retries:` is declared; otherwise 60s |

## Using it as a library

```ts
import { launchUp, launchDown, launchStatus } from "@launchfile/macos-dev";
```

`launchUp`, `launchDown`, `launchStatus`, `launchEnv` and `launchBootstrap` drive the lifecycle. `LaunchUpOpts` describes the options.

## Links

- Spec and provider contract: [launchfile.dev](https://launchfile.dev)
- Source: [providers/macos-dev](https://github.com/launchfile/launchfile/tree/main/providers/macos-dev)
- License: MIT
