---
"@launchfile/docker": minor
---

Warn when postgres `config.extensions` cannot apply. The extensions reach postgres through an init script mounted into `/docker-entrypoint-initdb.d/`, and postgres reads that directory only while it initializes an empty data directory. Since the data directory moved onto the named volume that `launchfile down` preserves, an extension added to a deployment that has already run was never created — the image swapped to `pgvector/pgvector:pg16`, the SQL never ran, and nothing said so until the app's first query failed.

`up` now resolves the volume Compose actually created for that service and, when it exists, warns before starting: it names the service and the declared extensions, states that postgres creates them only at first initialization, and gives both remedies — `launchfile down --destroy` then `launchfile up`, which deletes that service's data, or running the `CREATE EXTENSION` statements by hand, which does not. Detection only: the provider runs no SQL and asks the database nothing, so the warning reports what the provider does, never what the database contains.

`ComposeResult` gains `initOnlyExtensions`, the pure generator's report of which services deliver extensions this way — the same split as `storageBinds`, where the generator names the requirement and the caller checks the host.
