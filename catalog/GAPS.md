# Launchfile Spec Gaps — Found by Testing Real Apps

Discovered by writing Launchfiles for real-world self-hosted apps across multiple tiers of complexity.
Each gap includes the apps that exposed it and a severity rating.

**Legend**: 🔴 Blocks real apps / 🟡 Workaround exists / 🟢 Nice-to-have

---

## Expression & Wiring

### G-1: No `$components` reference validation 🟡
**Apps**: Ollama+OpenWebUI, Dify, Changedetection, HedgeDoc, Hoppscotch
**Issue**: `$components.ollama.url` passes schema validation as a plain string. A typo like `$components.olama.url` isn't caught until runtime resolution.
**Workaround**: Reader accepts it; resolution fails silently (empty string).
**Suggestion**: Validate `$components.*` references against declared component names during a post-parse check.

---

## Resource Types & Properties

### G-3: No `mariadb` in well-known resource types 🟡
**Apps**: Appwrite
**Issue**: `type: mariadb` parses fine (arbitrary strings allowed) but has no documented property vocabulary. Orchestrators need to know MariaDB uses the same connection model as MySQL.
**Workaround**: Works as-is; just undocumented.
**Suggestion**: Add `mariadb` to the resource type enum, aliased to MySQL's property set.

### G-4: No `clickhouse` in well-known resource types 🟡
**Apps**: Plausible
**Issue**: Same as G-3 but for ClickHouse. Properties would differ (different URL scheme, no user/password by default).
**Workaround**: `type: clickhouse` with `set_env: { CLICKHOUSE_DATABASE_URL: $url }` works structurally.

### G-5: MongoDB replica set config not expressible 🟡
**Apps**: Rocket.Chat
**Issue**: Rocket.Chat needs MongoDB with replica set enabled. `requires.config` can hold `{ replicaSet: "rs0" }` but there's no convention for generating an oplog URL vs standard URL, or for expressing "must be a replica set."
**Workaround**: Use `config: { replicaSet: rs0 }` and document that the orchestrator must handle it.

### G-6: No resource property registry / validation 🟡
**Apps**: All apps using `set_env`
**Issue**: `$host`, `$port`, `$url` etc. are convention, not validated. A typo like `$hoost` isn't caught.
**Workaround**: Works at runtime — resolver returns empty string for unknown properties.
**Suggestion**: Define a machine-readable property registry per resource type (already in plan as L-4).

---

## Protocol & Networking

### G-9: No multicast / link-local network capability declaration 🟡
**Apps**: Home Assistant
**Issue**: Home Assistant uses mDNS and SSDP for local device discovery. Both protocols rely on multicast, which Docker's default bridge network does not forward between containers and the host LAN segment. There is no way in Launchfile to declare that an app requires multicast or link-local network access. The spec should express the capability needed, not a Docker-specific implementation mechanism like `network_mode: host`.
**Approaches**:
- **Declare required protocols** — `network.protocols: [multicast, link-local]`; orchestrator satisfies it however fits the platform. Most portable.
- **Host network attachment** — `network.mode: host` escape hatch; grants full access to the host network stack. Blunt but universally effective.
- **macvlan / ipvlan attachment** — `network.driver: macvlan`; gives the container its own MAC/IP on the host LAN, joins the segment natively without sharing the host's network namespace.
- **Multicast proxy (no spec change)** — orchestrator runs `avahi-daemon` or `udpxy` on the host to relay mDNS/SSDP into the bridged container. Platform-side responsibility; no Launchfile field needed.
**Suggestion**: Add `network.protocols:` to declare required protocol capabilities (e.g., `multicast`, `link-local`). Orchestrator maps this to the appropriate platform implementation.

### G-9b: Zigbee/Z-Wave USB dongle access *(see G-11)*
**Apps**: Home Assistant
**Issue**: Home Assistant requires host USB device passthrough (`/dev/ttyUSB0`, `/dev/ttyACM0`) for Zigbee and Z-Wave coordinators. This is a device access concern, not a networking one — captured in G-11 (No device passthrough).

---

## Hardware & Device Access

### G-10: No GPU / accelerator declaration 🟡
**Apps**: Ollama, Jellyfin, Plex, Immich (ML component)
**Issue**: `platform` covers CPU architecture but not GPU requirements. No way to declare "needs nvidia GPU" or "benefits from hardware transcoding."
**Suggestion**: Add `accelerator:` field or `devices:` list. v2 candidate.

### G-11: No device passthrough 🟡
**Apps**: Jellyfin (`/dev/dri`), Home Assistant (USB dongles), Diun (Docker socket)
**Issue**: No way to express `--device /dev/dri:/dev/dri` or bind mount `/var/run/docker.sock`. The `storage` model only covers persistent data volumes.
**Suggestion**: Add `devices:` list or `mounts:` for non-storage bind mounts. Overlaps with G-10.

---

## Storage & Volumes

### G-12: No host bind mount / socket mount support 🟡
**Apps**: Diun (Docker socket), Home Assistant (USB), Calibre Web (host book library)
**Issue**: `storage` only expresses app-owned persistent volumes. Host bind mounts (mounting a host directory into the container) and socket mounts are not supported.
**Workaround**: Omit from Launchfile; configure at the orchestrator level.
**Assessment**: Host bind mounts are inherently platform-specific. But Docker socket access is common enough to warrant a pattern.

### G-13: No cross-component volume sharing 🟡
**Apps**: Changedetection (app + browser sharing datastore), Nextcloud (app + cron sharing /var/www/html)
**Issue**: Each component declares its own `storage`. No way to say "component B mounts the same volume as component A."
**Suggestion**: Named volumes at the top level, referenced by components. Similar to Docker Compose's top-level `volumes:`.

---

## Env Var Patterns

### G-14: No one-time / ephemeral token model 🟢
**Apps**: Plex (PLEX_CLAIM token, expires in 4 minutes)
**Issue**: `generator` supports `secret | uuid | port` but no concept of externally-fetched, time-limited tokens.
**Assessment**: Very niche. Can be handled by the orchestrator prompting the user.

### G-15: No `env_file` or `.env` import 🟢
**Apps**: Many (esp. LinuxServer.io images with PUID/PGID patterns)
**Issue**: No way to say "import env vars from this file." Apps with many env vars (Supabase has 30+) become verbose.
**Assessment**: Verbosity is acceptable — Launchfile is the source of truth. YAML anchors help with reuse.

### G-16: `generator: secret` configuration 🟢
**Apps**: Various
**Issue**: No way to configure the generated secret (length, character set, format). All secrets are the same format.
**Assessment**: Low priority — a 32-char hex string works for most cases.

---

## Component Lifecycle

### G-17: No `command` / `entrypoint` override (Docker-native) 🟡
**Apps**: Dify (worker uses same image with different command), Nextcloud (cron component)
**Issue**: `commands.start` works but feels like a workaround. Docker's `command` and `entrypoint` are distinct concepts. Some images expect the command as args to the entrypoint.
**Workaround**: `commands.start` covers most cases. The distinction between command and entrypoint matters mainly for wrapper scripts.

### G-18: Scheduled components without `provides` are ambiguous 🟢
**Apps**: Diun, Nextcloud cron
**Issue**: Omitting `provides` works, but orchestrators can't distinguish "no port needed" from "port not specified yet." Matters for reverse proxy setup.
**Assessment**: Convention: no `provides` = no web port. Document it.

---

## Container Runtime

### G-19: Docker volume ownership for non-root containers 🟡
**Apps**: OpenClaw (node user), any image running as non-root
**Issue**: Docker named volumes are created with root ownership. When a container runs as a non-root user (e.g., `node` uid 1000), writing to mounted volumes fails with `EACCES: permission denied`. This is a Docker provider concern, not a Launchfile spec issue — the app correctly declares `storage.data.path`, and the orchestrator must satisfy it.
**Workaround**: Run containers as root (`user: "0:0"` in compose) or use an init entrypoint to `chown` the mount. Anonymous volumes inherit image filesystem ownership but don't persist across `down -v`.
**Assessment**: This belongs in the Docker provider, not the spec. Kubernetes solves it with `fsGroup`. The Launchfile spec should not add user/group fields — that's platform-specific. Docker providers should inspect the image's `USER` directive and set volume ownership accordingly.

### G-20: Apps binding to localhost only 🟡
**Apps**: *(no catalog apps currently affected — OpenClaw binds to `0.0.0.0` when run as root)*
**Issue**: Some apps bind their HTTP server to `127.0.0.1` or `::1` only, making them unreachable from outside the container even with Docker port mapping. The Launchfile `provides.port` declares what the app exposes, but if the app itself refuses connections from non-loopback addresses, Docker port forwarding silently fails.
**Workaround**: Orchestrator adds a sidecar reverse proxy (nginx/socat) or the app provides an env var to configure the bind address.
**Assessment**: This is an app configuration concern. The spec's `provides.bind` field declares the expected bind address. The test harness compose translator now detects loopback-bound exposed ports (`provides.bind` set to `::1` or `127.0.0.1`) and auto-generates a socat sidecar sharing the network namespace to forward `0.0.0.0:PORT → bind:PORT`. Health checks also use the declared bind address instead of defaulting to `localhost`. Note: OpenClaw was originally flagged here because its gateway binds to `::1` when running as the `node` user, but the test harness runs containers as root (`user: "0:0"` for G-19), which causes OpenClaw to bind to `0.0.0.0` instead.

---

## Summary by Severity

| Severity | Count | Gaps |
|----------|-------|------|
| 🔴 Blocks real apps | 0 | *(G-2 shared secrets and G-8 UDP now addressed in spec)* |
| 🟡 Workaround exists | 13 | G-1, G-3, G-4, G-5, G-6, G-9, G-9b, G-10, G-11, G-12, G-13, G-17, G-19, G-20 |
| 🟢 Nice-to-have | 4 | G-14, G-15, G-16, G-18 |

## Apps per Gap

| Gap | Apps affected |
|-----|--------------|
| G-1 | Ollama+OpenWebUI, Dify, Changedetection, HedgeDoc, Hoppscotch |
| G-3 | Appwrite |
| G-4 | Plausible |
| G-5 | Rocket.Chat |
| G-6 | All apps using `set_env` |
| G-9 | Home Assistant |
| G-9b | Home Assistant |
| G-10 | Ollama, Jellyfin, Plex, Immich |
| G-11 | Jellyfin, Home Assistant, Diun, Calibre Web |
| G-12 | Diun, Home Assistant, Calibre Web |
| G-13 | Changedetection, Nextcloud |
| G-14 | Plex |
| G-15 | Many (cosmetic) |
| G-16 | Various (cosmetic) |
| G-17 | Dify, Nextcloud |
| G-18 | Diun, Nextcloud cron |
| G-19 | OpenClaw, any non-root image |
| G-20 | OpenClaw |
