# @launchfile/docker

Run a [Launchfile](https://launchfile.dev) app with Docker Compose.

This package is the Docker provider behind the `launchfile` CLI. Most people use it through the CLI and never import it:

```bash
npx launchfile up ghost        # Ghost + MySQL, from the catalog
npx launchfile up ./Launchfile # any local Launchfile
npx launchfile down --destroy  # remove containers, volumes and networks
```

## Install

```bash
npm install @launchfile/docker   # or: bun add @launchfile/docker
```

You only need this to use the provider as a library. The `launchfile` CLI already depends on it.

## What it does

- Translates a Launchfile into a `docker-compose.yml` (`launchToCompose`) and runs it with `docker compose`.
- Uses `image:` when a component declares one, and builds components that declare `build:` with `docker compose build`. Building inside Docker keeps an untrusted source off the host.
- Runs the artifact-context commands: `commands.release` once before `up` (a failure fails the deploy), `commands.start`, and `bootstrap`. Source-mode commands (`install`, `dev`) are ignored (D-38).
- Provisions `requires:` resources (postgres, mysql, mariadb, redis and more) as backing-service containers, and injects each entry's `set_env` bindings into the component's environment.
- Waits for each component's `health:` check before `up` returns. If the budget runs out, `up` fails and the containers are left running so `launchfile status` and `launchfile logs` can show what never came up.

## Timeout defaults

Used when a command declares no `timeout:`, plus the health-gate budget on `up`, which no Launchfile field sets ([PROVIDERS.md §10](https://github.com/launchfile/launchfile/blob/main/spec/PROVIDERS.md)):

| Stage               | Default |
|---------------------|---------|
| `release`           | 10m     |
| `bootstrap`         | 2m      |
| health gate on `up` | 120s    |

## Using it as a library

```ts
import { dockerUp, dockerDown, launchToCompose } from "@launchfile/docker";
```

`dockerUp`, `dockerDown`, `dockerStatus`, `dockerLogs` and `dockerList` drive the lifecycle. `launchToCompose` returns the compose document without running anything. The exported types (`ComposeOpts`, `DockerUpOpts`, and others) describe their options.

## Links

- Spec and provider contract: [launchfile.dev](https://launchfile.dev)
- Source: [providers/docker](https://github.com/launchfile/launchfile/tree/main/providers/docker)
- License: MIT
