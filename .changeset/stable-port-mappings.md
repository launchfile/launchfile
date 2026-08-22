---
"@launchfile/docker": minor
---

Stable host mappings for every published endpoint, and D-27-correct publication.

- Every endpoint marked `exposed: true` now gets an explicitly allocated host
  port, persisted in state and reused across restarts — previously only a
  component's first endpoint was mapped and the rest were emitted as bare
  container ports, so Docker re-picked them on every recreate.
- Endpoints that do not set `exposed: true` are no longer published to the
  host (they stay reachable in-network). This matches the spec: `exposed`
  defaults to `false` (D-27). Previously entries that merely omitted `exposed`
  were published on random host ports.
- UDP endpoints are published with the `/udp` protocol suffix instead of
  silently as TCP; `bind` applies per endpoint.
- `launchfile up` / `status` summaries list every published endpoint with a
  protocol-correct address (no more `http://` links to tcp/udp ports), keyed
  by endpoint name (D-6).
- `$app.*` now derives from the first component with an `exposed: true`
  endpoint, matching its documented contract — for apps whose first
  provides-bearing component was internal (e.g. a database), `$app.url` now
  points at the actual public component.
