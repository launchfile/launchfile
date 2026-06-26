# Launchfile CLI Roadmap

The unified `launchfile` CLI — one command for spec tooling and local deployment.

## Command Grammar

```
launchfile <verb> [target] [flags]
```

## Command Table

```
VERB          TARGET              FLAGS                         PHASE
────────────────────────────────────────────────────────────────────
up            [slug|path]         --docker/--native/-d/--dry-run  1 ✓
down          [id|slug|name]      --destroy                       1 ✓
status        [id|slug|name]                                      1 ✓
logs          [id|slug|name]      --follow                        1 ✓
list / ls     —                                                   1 ✓
env           [id|slug|name]      [component]                     1
validate      [path]              --json --quiet                  1 ✓
inspect       [path]                                              1 ✓
schema        —                   --schema-path                   1 ✓

deploy        <slug|path>         --provider --name --target      2
deployments   —                   --provider --app                2
destroy       <id|name>           --force                         2
init          —                   (interactive)                   2
catalog       [search]                                            2

scale         <id|name>           --count                         3
resources     [id|name]                                           3
```

## Use Cases

### UC1: Catalog app via Docker

```bash
$ launchfile up ghost
# Fetches Launchfile from catalog, pulls ghost:5-alpine + mysql:8
# Ghost running at http://localhost:2368
# Deployment: a3f2b1c

$ launchfile down --destroy
# Removes containers, volumes, state — 100% clean
```

### UC2: Local project

```bash
$ cd ~/code/myapp
$ launchfile up
# Reads ./Launchfile, provisions postgres, starts app
# Deployment keyed to this directory

$ launchfile status    # shows THIS directory's deployment
$ launchfile down      # stops THIS directory's deployment
```

### UC3: Multiple worktrees of the same repo

```bash
$ cd ~/code/myapp && launchfile up
# myapp at http://localhost:3000 — deployment a3f2b1c

$ cd ~/code/myapp-feat && launchfile up
# myapp at http://localhost:3001 — deployment e7d4c2a (different port!)

$ launchfile list
# ID       APP     SOURCE                    PROVIDER  PORT   STATUS
# a3f2b1c  myapp   ~/code/myapp              docker    3000   up
# e7d4c2a  myapp   ~/code/myapp-feat         docker    3001   up

$ launchfile down myapp
# ERROR: Multiple deployments of myapp — specify ID or run from project dir
```

### UC4: Named deployments

```bash
$ launchfile up ghost --name=ghost-test
# ghost at :2369 — deployment cc53228
$ launchfile down ghost-test
```

### UC5: Provider override

```bash
$ launchfile up --native     # macOS native (brew services)
$ launchfile up --docker     # Docker even if on macOS
```

## Deployment Identity

| Form | When it works |
|------|--------------|
| **pwd** | In a directory with a Launchfile |
| **App slug** | Only one deployment of that app |
| **Short hash** (7-char hex) | Always unique |
| **Name** | User-assigned via `--name` |

Resolution order: ID → name → app slug → pwd.

## State

```
~/.launchfile/
  config.yaml                       # User preferences
  deployments/
    index.json                      # Fast deployment lookup
    {id}/
      state.json
      docker-compose.yml
```

## Provider Auto-Detection

1. `--docker` flag → Docker
2. `--native` flag → macOS native
3. Docker daemon running → Docker
4. macOS without Docker → macOS native
5. Otherwise → error with guidance

## Phase 2 Design Sketch: Cloud Build & Deploy

`launchfile deploy` extends the same Launchfile to remote infrastructure. The local providers established the translation pattern; a cloud provider adds two concerns the local ones don't have — **artifact publishing** and **managed resources**.

### Pipeline

```
validate → build → publish → provision → release → start → (bootstrap)
```

| Step | Local provider today | Cloud provider |
|------|---------------------|----------------|
| build | `docker compose build` (from `build:`) | Remote builder (platform builder, BuildKit, buildpack from `runtime:`) |
| publish | — (image stays in local daemon) | Push to the platform registry; tag from `image:` or platform-assigned |
| provision | Container / brew service per `requires:` | Managed service (RDS, Cloud SQL, Upstash) — same property vocabulary (`$url`, `$host`, `$password`) wired via `set_env` |
| release | `commands.release` in ephemeral container | Same, in a release run on the platform |
| start | compose `up` / process manager | Platform deploy primitive (Fly machine, K8s Deployment, ECS service) |
| `$app.*` | `http://localhost:<port>` | Platform routing (assigned domain → `$app.url`, `$app.host`) |
| bootstrap | `docker compose exec` / local spawn | Platform exec (`fly ssh console -C`, `kubectl exec`) with the same capture semantics |

Key properties to preserve:

- **The Launchfile does not change between local and cloud.** Everything provider-specific (region, instance size, registry) lives in provider config (`--provider`, `--target`, `~/.launchfile/config.yaml`), never in the Launchfile (P-1, P-5).
- **`install` / `dev` commands are ignored entirely** — cloud providers execute the artifact (D-38).
- **Secrets**: `generator:` secrets are created in the platform's secret store on first deploy and persist across deploys, mirroring how local providers persist them in state.
- **Builds are remote by default.** The user's machine never needs the toolchain; this is the same trust posture as the containerized local build, lifted to the platform.

## Relationship to Launchpad

| launchfile (open source) | launchpad (commercial) |
|-------------------------|----------------------|
| `up` | `launch` |
| `down` | `stop` |
| `down --destroy` | `destroy` |
| `status` | `status` |
| `list` | `list` |
| `deploy --provider=launchpad` (future) | `launch --target` |

Features that belong in Launchpad (not launchfile CLI):
- AI-powered repo analysis
- Routing / subdomain management
- Web dashboard
- Dev sessions
- Remote server management
- Shared service pool
