# Launchfile Provider Contract

> **Status: draft for review.** `SPEC.md` defines the *file*; this document defines what a **provider** does with it — the runtime counterpart. Parts marked 📐 depend on RFCs [#77](https://github.com/launchfile/launchfile/issues/77), [#79](https://github.com/launchfile/launchfile/issues/79), [#78](https://github.com/launchfile/launchfile/issues/78) and the cross-invocation state design note, which are not yet ratified. Parts marked ✅ are implemented in the reference providers today.

A **provider** translates a Launchfile into a running (or described) deployment on one target — Docker Compose locally, native services on macOS, Terraform for AWS, Kubernetes, etc. The format captures *intent*; the provider maps intent to execution (P-1, P-5, P-11). This contract is what keeps "same file, every provider" (12-Factor X) honest.

**Status legend:** ✅ implemented in a reference provider · 🔶 specified, partially implemented · 📐 proposed (pending RFC / design note).

---

## 1. Relationship to the other specs

| Doc | Defines |
|-----|---------|
| `SPEC.md` | The file contract — fields, types, expressions. |
| `DESIGN.md` | Format design decisions (D-\*), principles (P-\*), limitations (L-\*). |
| **`PROVIDERS.md`** | **The runtime contract — verbs, lifecycle, modes, selection, build line, state.** |
| `CLI-ROADMAP.md` | The reference CLI surface (`launch <verb> [target] [flags]`). |

The provider contract is normative for *anyone* implementing a provider, whether or not they use the reference `@launchfile/sdk`.

---

## 2. Verbs — the operational surface

A provider exposes a subset of these operations. `up`/`down`/`status` are the minimum for a runtime provider; a translation-only provider (e.g. AWS → Terraform) may implement only `translate`.

| Verb | Purpose | Status |
|------|---------|--------|
| `up` | Provision resources, prepare, and run the app (or a selected subset). | ✅ docker, macos-dev |
| `down` | Stop and (with `--destroy`) remove the deployment. | ✅ docker, macos-dev |
| `status` | Report what is running for a deployment. | ✅ docker, macos-dev |
| `logs` | Stream/print component logs. | ✅ docker |
| `env` | Print a component's **resolved** environment as `export K=V`. | ✅ macos-dev |
| `list` | List known deployments. | ✅ docker |
| `translate` | Emit target artifacts without deploying (IaC, manifests). | 📐 (AWS probe) |

Identity & re-location: a provider keys each deployment by a stable id (slug / directory / content hash) so the CLI can re-find it later (see §7).

---

## 3. Lifecycle slots 📐 (RFC #77)

A provider operates on **slots**, not raw command names. A slot is a lifecycle phase; *which command fills it* is a mode-resolution detail (§4). Two slots are mode-aware; the rest are invariant.

| Slot | Purpose | Command by mode | When |
|------|---------|-----------------|------|
| **prepare** | make the app runnable (deps, compile, package) | artifact `build` · source `install` | on change / on demand |
| **release** | one-off tasks before serving (migrations) | `release` | per deploy |
| **run** | the long-running process | artifact `start` · source `dev` | every launch |
| **bootstrap** | post-run setup against the running app | `bootstrap` | on demand after run |
| **seed / test / …** | ad-hoc | `seed` / `test` / custom | on demand |

Providers SHOULD surface progress on slot boundaries (`prepare.start/end`, `run.healthy`, …) — see §7. `prepare` MUST run on demand / on input change, **not** on every `run`.

> **12-Factor V (build/release/run):** `prepare` generalizes factor V's *build* (the source command is an *install*, not a *build*). `prepare` is the slot; `build` is the artifact-mode command that fills it.

---

## 4. Execution modes 📐 (RFC #77)

A provider runs in exactly one **mode** per launch — `artifact` (built image/platform build) or `source` (run from the working tree). Mode is **requested globally and resolved per component**.

**Run resolution, source mode, per component:**

1. `dev` present → run `dev` from source (in the component's `source:` dir).
2. else `image` present → run as **artifact** (the image is the only runnable form).
3. else → run `start` from source (`prepare`'s `build` produces any output `start` needs).

**Prepare** (for a component resolved to source): `install` if present, else `build`.

**Field partition** — exactly one of the first two sets is active per component per launch:

| Set | Members | Active in |
|-----|---------|-----------|
| Artifact | `image`, `build`, `start` | artifact mode |
| Source | `source`, `install`, `dev` | source mode |
| Invariant | `provides`, `requires`, `depends_on`, `health`, `storage`, `env`, `release`, `bootstrap`, `seed`, `test` | always |

Resources (`requires`) have **no source form** — provisioned identically in both modes. A cloud/artifact-only provider MUST ignore source-mode fields.

---

## 5. Component selection & `--deps-only`

`up`/`down`/`status`/`dev` accept an optional **component selector** (verb argument, not a file field — RFC #77).

- Selecting a component provisions its `requires`; selecting nothing acts on all components. ✅ (docker, macos-dev — `selectComponents()` in the SDK)
- `depends_on` is a readiness constraint to **satisfy**, not a selection to **expand** (fail loud if a dependency isn't running; `--with-deps` to opt in). 🔶
- **`--deps-only[=requires|supports]`** 📐 — provision the resource closure of the selected (or all) components and start **no component**. It never traverses `depends_on`. `requires` = mandatory; `supports` = optional (L-6, orchestrator-activated). A backing service modeled as a *component* (not a `requires`) is not picked up — select it explicitly.

---

## 6. Build: portable contract vs. provider specialization 📐 (RFC #78)

- **Portable contract (every provider MUST be able to build from):** `runtime` + `commands` (`build`/`install`/`start`/`dev`/…). 
- **Provider specialization (fenced):** in-repo recipes a provider discovers — `build.dockerfile`/`target`/`args` (OCI family), `nixpacks.toml`, `Procfile`, etc. Rules: **discovered, not enumerated**; **never the sole build path** (a provider that understands none of an app's specializations MUST still build it from the contract; `validate` warns when only a Docker recipe exists); **ignored safely** (unknown recipe → fall back to contract, never error).

A specialization makes a matching provider more faithful; it never makes the app deployable only on that provider.

---

## 7. Deployment state & the event model 📐 (cross-invocation state design note)

Providers persist deployment state so `status`/`env`/`down` work across shells, and so **separate invocations can compose one app** (`launch up backend && launch dev frontend`) by sharing the runtime-resolved values (actual ports, generated secrets, captures) that env inheritance cannot carry sibling-to-sibling.

**Model:** event-sourced state, the file as the shared projection.

```
runtime → [events] → reduce() → atomic write ─┐
                                              ├─ state file (LAUNCHFILE_STATE)
local watcher ← emit ← diff() ← fs change ────┘
```

**SDK (pure, no I/O)** provides the vocabulary and folds — `LaunchEvent`, `DeploymentState`, `reduce`, `diff`, `resolveRef(state, ref, vantage)`. The provider/orchestrator owns the I/O: atomic write (`temp + rename(2)`, `flock(2)`), `fs.watch`, terminal rendering, and deployment-id resolution.

- **Resolution by vantage:** `resolveRef` picks an endpoint's `published` vs `internal` address from the *consumer's* vantage (host-native → `localhost:3001`; in-network → `backend:3000`). Endpoints therefore carry both.
- **One stream, three surfaces:** persistence (the rendezvous file), terminal/UI statuses, and reactivity (`depends_on` gates, supervisors, dev reload).
- **Deployment id (so `&&` is one deployment, not two):** `--state <path>`/`--name <id>` › `LAUNCHFILE_STATE` env › implicit app+dir.
- **`launch env`** reads this state and emits resolved, vantage-aware `export K=V` — `eval "$(launch env backend)"`.

> Today each reference provider persists its **own** state shape (see §8); the unified `DeploymentState` + event model is the proposed standardization.

---

## 8. Reference providers — implemented today ✅

### `@launchfile/docker` — artifact / container

- **Verbs:** `up`, `down`, `status`, `logs`, `list`.
- **`up` opts:** `detach`, `dryRun`, `yes`. **Returns:** `slug`, `appName`, `sourceType` (`local | catalog | url`), `sourcePath`/`sourceUrl`.
- **Translation:** Launchfile → `docker-compose.yml` (compose-generator); one compose project per deployment, keyed by `slug`.
- **Ports:** host-port allocation, persisted and collision-avoided across deployments (UC3 worktrees get distinct ports).
- **Build:** components with `build:` are built from source **inside `docker compose build`** (BuildKit — nothing from the repo runs on the host); `image:` services are pulled.
- **Flow:** build (from source) → start (`compose up`) → bootstrap.
- **Sources:** local path, catalog slug, remote URL (with a confirmation prompt for remote, bypassable via `yes`).
- **State:** `DockerState` per slug (compose project/path, allocated ports, source info) under the provider state dir.
- **Selection:** honors the component selector; the post-`up` summary reports only the started subset.

### `@launchfile/macos-dev` — source / native

- **Verbs:** `up`, `down`, `status`, `env`.
- **`up` opts:** `withOptional`, `noBuild`, `detach`, `dryRun`, `projectDir`.
- **Resources (native, via Homebrew services):** `postgres`, `mysql`, `redis`, `sqlite`.
- **Runtimes:** `bun`, `node`, `python`, `ruby`.
- **Prepare-on-change:** `lockfile-detect` decides when to (re)install — `prepare` is not re-run on every `up`.
- **Process management:** components are spawned detached; `pid`/`pgid`/`startedAt`/`command` are recorded so `down` from another shell can signal the whole group, guarded against pid reuse.
- **Also:** health checks, secret generation, persistent storage, env writing.
- **`env`:** prints a component's resolved environment — the read surface §7 generalizes.
- **State:** `LaunchState` at `<projectDir>/.launchfile/state.json`, keyed by Launchfile **content hash**; holds `resources`, `secrets`, `ports`, `processes`.
- **Selection:** narrows `components` after the prereq gate so every phase honors it.

### Mode coverage today

The docker provider is effectively **artifact-first** (it builds/pulls images); macos-dev is **source/native-first**. The explicit source/artifact mode taxonomy (§4) formalizes what these two already do in practice and is the bridge to a third, non-local provider.

---

## 9. Conformance — what a new provider must do

A provider claiming Launchfile support MUST:

1. **Build from the portable contract** (`runtime` + `commands`) — never require a provider-specific recipe (§6).
2. **Ignore specializations it doesn't understand** and still launch (§6).
3. **Resolve mode per component** for whatever modes it supports; ignore the other mode's fields (§4). (A cloud provider is typically artifact-only.)
4. **Honor the component selector** and `--deps-only` semantics (§5).
5. **Provision `requires` resources** as a precondition of any selected component; treat `depends_on` as satisfy-not-expand (§5).
6. **Persist resolved deployment state** and resolve cross-component references by consumer vantage (§7). Providers SHOULD interoperate via the shared state file so invocations compose.
7. **Report gaps, not silent drops** — if a field can't be honored, surface it (the AWS probe's conformance report is the model).

A **translation-only** provider (IaC/manifest emitter) satisfies the contract by mapping the fields above to its target and listing what it cannot map — it need not implement `up`/`down`.

---

*This contract consolidates the provider-facing halves of RFC #77 (modes, slots, selection), RFC #78 (build line), and the cross-invocation state design note. `DESIGN.md` remains the file-format decision log; provider-runtime decisions live here.*
