# Launchfile Provider Contract

> **Status: draft for review.** `SPEC.md` defines the *file*; this document defines what a **provider** does with it — the runtime counterpart. It consolidates ratified decisions **D-37** (execution mode vs. environment), **D-38** (`install`/`dev` + `source`), **D-39** (`$storage.*`), and **D-40** (the app/provider build line). Parts marked 📐 are not-yet-ratified elaborations — the cross-invocation state/event model (a design note) and `--deps-only`. Parts marked ✅ are implemented in the reference providers today.

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

Identity & re-location: a provider keys each deployment by a stable id (slug / directory / content hash) so the CLI can re-find it later (see §8).

---

## 3. Lifecycle slots (D-37)

A provider operates on **slots**, not raw command names. A slot is a lifecycle phase; *which command fills it* is a mode-resolution detail (§4). Two slots are mode-aware; the rest are invariant.

| Slot | Purpose | Command by mode | When |
|------|---------|-----------------|------|
| **prepare** | make the app runnable (deps, compile, package) | artifact `build` · source `install` | on change / on demand |
| **release** | one-off tasks before serving (migrations) | `release` | per deploy |
| **run** | the long-running process | artifact `start` · source `dev` | every launch |
| **bootstrap** | post-run setup against the running app | `bootstrap` | on demand after run |
| **seed / test / …** | ad-hoc | `seed` / `test` / custom | on demand |

Providers SHOULD surface progress on slot boundaries (`prepare.start/end`, `run.healthy`, …) — see §8. `prepare` MUST run on demand / on input change, **not** on every `run`.

> **12-Factor V (build/release/run):** `prepare` generalizes factor V's *build* (the source command is an *install*, not a *build*). `prepare` is the slot; `build` is the artifact-mode command that fills it.

---

## 4. Execution modes (D-37, D-38)

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

`up`/`down`/`status`/`dev` accept an optional **component selector** (verb argument, not a file field — D-37).

- Selecting a component starts it **plus its transitive downward dependency closure** — its `depends_on` target components and every closure member's `requires` backing services (**D-41**). Selecting nothing acts on all components. ✅ (docker, macos-dev — `selectComponents()` / `selectionClosure()` in the SDK)
- The closure is **downward only**: `up backend` never starts `frontend` (a reverse-dependency) or unrelated components, and **already-running dependencies are left untouched** (idempotent). `depends_on` is honored as a hard prerequisite (D-16), so a selected component's `depends_on` targets come along — they are not left down for the operator to satisfy. A future `--no-deps` opt-out starts only the directly-named components.
- **`--deps-only[=requires|supports]`** 📐 — provision the resource closure of the selected (or all) components and start **no component**. It never traverses `depends_on`. `requires` = mandatory; `supports` = optional (L-6, orchestrator-activated). A backing service modeled as a *component* (not a `requires`) is not picked up — select it explicitly.

---

## 6. Build: portable contract vs. provider specialization (D-40)

- **Portable contract (every provider MUST be able to build from):** `runtime` + `commands` (`build`/`install`/`start`/`dev`/…). 
- **Provider specialization (fenced):** in-repo recipes a provider discovers — `build.dockerfile`/`target`/`args` (OCI family), `nixpacks.toml`, `Procfile`, etc. Rules: **discovered, not enumerated**; **never the sole build path** (a provider that understands none of an app's specializations MUST still build it from the contract); **ignored safely** (unknown recipe → fall back to contract, never error). `build.dockerfile`/`target`/`args` are reclassified as OCI-family hints — never removed. No general `x-<provider>:` block is admitted.

A specialization makes a matching provider more faithful; it never makes the app deployable only on that provider.

**Reduced-portability diagnostic (D-40):** a `validate`-only, non-fatal, **suppressible** warning that fires when an app's only build path is a provider-specific recipe (a Dockerfile) *or* a prebuilt `image:` with no portable `runtime`/`commands` contract. It is **never** emitted by operational commands (`up`/`down`/`logs`/…), so the image-first catalog is unaffected in normal flows — only an explicit `validate` surfaces it. A second case (D-43): a **source-needing app with no reachable origin** — no `image:`, evaluated detached, and no `repository:` to fall back to. Same treatment: `validate`-only, non-fatal, suppressible.

### Source acquisition (D-43)

Any build or source-mode operation needs the app's source tree. Every provider resolves the tree through this precedence — a **local** provider trivially lands on rule 2, the checkout the Launchfile sits in:

1. **Orchestrator-supplied source.** A source the orchestrator hands the provider — a repo URL + ref, a tarball, or a local tree — MUST take precedence over everything below. This is the home-#2 channel (D-36): forks, private mirrors, and per-environment ref choices (`main` to staging, a tag to prod) all arrive here, never in the file.
2. **Attached context.** A Launchfile is **attached** iff it was read from within the app's own source tree — the checkout of the app it describes. That tree *is* the source; a remote provider MAY package and ship it as its build context. A file fetched standalone (a catalog entry, a URL) into a cache or temporary directory is **detached**, even though it momentarily sits in some directory.
3. **Detached fallback — `repository:`.** For a detached file, the `repository` field ([SPEC.md § Repository](SPEC.md#repository)) is the canonical origin the provider MAY fetch, at the ref named by its `#` fragment (default: the repository's default branch). Fetching and building a remote origin falls under the per-source confirmation rules (SPEC.md § Execution modes and source trust).

The in-file origin — URL and fragment alike — is a **baseline default, never a lock**: rule 1 always wins when the orchestrator supplies a source. A provider MUST NOT treat the fragment as pinning a deployment to that ref.

When no step resolves a source — detached, nothing supplied, no `repository:` — the operation fails with a clear error naming the missing origin; the D-43 `validate` diagnostic exists to surface exactly this case ahead of time.

A **translation-only** provider (§2) cannot ship a tree or perform a fetch; it MUST instead record the origin it *would* acquire (the resolved URL + ref, or "orchestrator-supplied" / "attached tree") in its emitted artifacts or conformance report, so the acquisition step is explicit rather than silently out of band.

---

## 7. Expression resolution — provider-supplied values ✅

The file declares *intent*; the provider supplies *values* (P-11). Beyond running commands, a provider MUST resolve the `$`-expressions in `env`, `set_env`, and command strings into concrete strings before the app sees them — a contract **ratified and implemented today** (D-33/D-35/D-36/D-39): the reference resolver and both reference providers resolve every namespace below.

**The three homes (D-36).** Every value in a Launchfile has exactly one home. The provider owns **home #3** — values it *computes* from its own routing, storage, provisioning, and `PATH` strategy. The app names the need; the provider resolves the value, the *same* expression yielding a different concrete string per provider. (Home #1 is the app's command/intent; home #2 is per-environment config the orchestrator supplies — neither is the provider's to invent.)

**Resolution order.** Reserved namespaces are matched **before** any user-named resource, so a resource or volume named `app`/`storage` cannot shadow them. An unknown reserved key resolves to the empty string (L-4), so a provider that doesn't supply a given value degrades gracefully (P-13) rather than erroring.

| Expression | Home-#3 value the provider supplies | Source |
|---|---|---|
| `$app.*` — `url`, `host`, `port`, `name`, `authority`, `scheme`, `tls` | the app's own public address, computed from the provider's routing strategy | D-33, D-35 |
| `$secrets.<name>` | an app-wide generated secret | D-18 |
| `$components.<name>.*` | a sibling component's endpoint, resolved by **consumer vantage** (§8) | — |
| `$storage.<name>.path` | the filesystem path the provider provisioned for the named volume | **D-39** |
| `$<resource>.<prop>` / enclosing `$url`, `$host`, … | a provisioned resource's connection properties | D-7 |

**Storage paths (D-39) — the home-#3 obligation made concrete.** The declared `storage.<name>.path` is the *canonical / container* path. A provider that provisions a volume MUST resolve `$storage.<name>.path` to the path it **actually used** and inject it wherever the app references it, so the path never has to appear in a command:

- a **container** provider bind-mounts the volume at the declared path → `$storage.<name>.path` = that path (e.g. `/data/cache`);
- a **native** provider provisions a host directory → `$storage.<name>.path` = that directory (e.g. `.launchfile/storage/<component>/cache`).

The same Launchfile is therefore correct under both, and an author never hardcodes a path only one provider understands — the exact failure D-36/D-39 close. A provider that does not provision storage leaves `$storage.*` unresolved (→ `""`).

> **Why resolution is the provider's job, not the file's:** a path, URL, or secret that varies by provider is home #3 — if the app embedded it, the file would stop being portable (P-1, P-5). Resolution is the mechanism that keeps "same file, every provider" honest, and is the concrete enforcement point for the [D-36](DESIGN.md#d-36-the-three-homes-of-a-varying-value-p-1-litmus-refinement) litmus.

---

## 8. Deployment state & the event model 📐 (cross-invocation state design note)

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

> Today each reference provider persists its **own** state shape (see §9); the unified `DeploymentState` + event model is the proposed standardization.

---

## 9. Reference providers — implemented today ✅

### `@launchfile/docker` — artifact / container

- **Verbs:** `up`, `down`, `status`, `logs`, `list`.
- **`up` opts:** `detach`, `dryRun`, `yes`. **Returns:** `slug`, `appName`, `sourceType` (`local | catalog | url`), `sourcePath`/`sourceUrl`.
- **Translation:** Launchfile → `docker-compose.yml` (compose-generator); one compose project per deployment, keyed by `slug`.
- **Ports:** host-port allocation, persisted and collision-avoided across deployments (UC3 worktrees get distinct ports).
- **Build:** components with `build:` are built from source **inside `docker compose build`** (BuildKit — nothing from the repo runs on the host); `image:` services are pulled.
- **Flow:** build (from source) → release (one-shot `docker compose run --rm` per declaring component, in `depends_on` order; compose brings that component's backing resources up healthy first, and a non-zero exit fails the deploy) → start (`compose up`) → bootstrap.
- **Sources:** local path, catalog slug, remote URL (with a confirmation prompt for remote, bypassable via `yes`).
- **Storage:** resolves `$storage.<name>.path` to the bind-mounted container path (D-39).
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
- **`env`:** prints a component's resolved environment (§7) — the read surface §8 generalizes.
- **Storage:** resolves `$storage.<name>.path` to `.launchfile/storage/<component>/<name>` on the host (D-39).
- **State:** `LaunchState` at `<projectDir>/.launchfile/state.json`, keyed by Launchfile **content hash**; holds `resources`, `secrets`, `ports`, `processes`.
- **Selection:** narrows `components` to the selected set's downward `depends_on` closure (`selectionClosure`) after the prereq gate, so every phase honors it.

### Mode coverage today

The docker provider is effectively **artifact-first** (it builds/pulls images); macos-dev is **source/native-first**. The explicit source/artifact mode taxonomy (§4) formalizes what these two already do in practice and is the bridge to a third, non-local provider.

---

## 10. Conformance — what a new provider must do

A provider claiming Launchfile support MUST:

1. **Build from the portable contract** (`runtime` + `commands`) — never require a provider-specific recipe (§6).
2. **Ignore specializations it doesn't understand** and still launch (§6).
3. **Resolve mode per component** for whatever modes it supports; ignore the other mode's fields (§4). (A cloud provider is typically artifact-only.)
4. **Honor the component selector** and `--deps-only` semantics (§5).
5. **Provision `requires` resources** as a precondition of any selected component, and **start the selected components' downward `depends_on` closure** (the declared dependency targets, transitively); never start unrelated components or reverse-dependencies (§5).
6. **Resolve the reserved expression namespaces it supports** — `$app.*`, `$storage.<name>.path`, resource properties, `$secrets.*`, `$components.*`; unknown reserved keys resolve to `""` (L-4). A provider that provisions storage MUST inject `$storage.<name>.path` so the path never appears in a command (D-36/D-39, §7).
7. **Persist resolved deployment state** and resolve cross-component references by consumer vantage (§8). Providers SHOULD interoperate via the shared state file so invocations compose.
8. **Report gaps, not silent drops** — if a field can't be honored, surface it (the AWS probe's conformance report is the model). `schedule` carries the hard form of this rule: a provider that does not execute a component's `schedule` MUST emit a launch-time warning naming the component (D-51) — an unexecuted schedule produces no error, no missing endpoint, nothing the author could notice at launch, so silence reads as success. This is distinct from the unknown-key tolerance (P-6; SPEC.md's "unknown keys are ignored"): `schedule` is a specified field, and known-but-unexecuted is a gap to report, not an extension to skip.
9. **Grant or refuse `host:` capability entries** — mount/forward the capability's coordinate and populate its properties, or refuse the component with a clear surfaced message; never deploy a component whose required capability was silently dropped (§11).
10. **Honor the failure semantics** (SPEC.md § Failure semantics) — a provider executing a deploy MUST run a declared `release` after the component's required resources are ready and before `start`, and MUST fail the deploy on its error. A provider that cannot run one-shot commands says so (item 8), never skips `release` silently. A provider MUST NOT silently substitute a default for an unparseable duration — it surfaces the error with the disposition of the stage the duration belongs to. Numeric timeout *defaults* for absent durations remain provider-side; a provider MUST document its defaults.
11. **Interpret command strings with a POSIX shell** (SPEC.md § Command interpretation) — or report the command unhonored per item 8. A provider MUST NOT split a command on whitespace and execute the first token: any command using `&&`, a pipe, a redirection or variable expansion is silently mangled, and the failure names a binary the author never wrote.

A **translation-only** provider (IaC/manifest emitter) satisfies the contract by mapping the fields above to its target and listing what it cannot map — it need not implement `up`/`down`.

---

## 11. Host capabilities — the grant/refuse fulfillment mode ✅ (D-44)

`requires`/`supports` entries marked `host:` (SPEC [Host capabilities](SPEC.md#host-capabilities)) are **not provisioned** — they are **granted or refused**. This is a distinct fulfillment mode from provisioning backing services (§10 item 5). A provider MUST do one of:

- **Grant** — mount or forward the capability's underlying coordinate (e.g. bind-mount `/var/run/docker.sock`, or forward a TCP endpoint) and populate the capability's properties — `$socket`, `$url`, `$api` for `container_runtime` — so the entry's `set_env` wiring resolves.
- **Refuse** — decline to deploy the component, with a **clear, surfaced message** naming the capability it cannot grant (§10 item 8: report gaps, not silent drops). A refusal is user-visible output, not a line buried in a warnings array.

Required vs optional follows the entry's home: a `requires` capability MUST be granted or the component refused; a `supports` capability MAY be left ungranted — the component still deploys, its capability `set_env` vars are simply absent, and the provider SHOULD note the un-granted capability so the degradation is visible.

The legacy top-level `host:` block carries the same semantics (its keys are the same capabilities in block spelling) and MUST be honored equivalently — a file using the new entry form and a file using the legacy block get the same grant/refuse outcome.

**Reference refuse behavior — `@launchfile/docker`.** The Docker provider *refuses* required host capabilities: a component with a required `container_runtime` (or legacy `host.docker: required`), `network: host`, or `privileged: true` capability is excluded from the generated compose project with a surfaced `refused: …` message — it declines rather than attempting Docker-in-Docker. Optional (`supports`) capabilities are left ungranted with a note. A provider that can safely grant (e.g. a VM-per-app provider mounting the runtime socket into an isolated guest) grants and populates the coordinates instead.

---

*This contract consolidates the provider-facing halves of **D-37** (modes, slots, selection), **D-38** (`install`/`dev`/`source`), and **D-40** (build line), plus the cross-invocation state/event design note. `DESIGN.md` remains the file-format decision log; provider-runtime decisions live here.*
