---
"@launchfile/docker": patch
---

Fix a crash at module load when `@launchfile/docker` is imported from a compiled standalone binary. The logger built its destinations with pino's worker-thread transport API, and transport workers resolve their scripts from on-disk `node_modules` at runtime. A consumer built with `bun build --compile` has no `node_modules`, so pino threw before the provider finished loading. The destinations are now built in-process with `pino.multistream`, using `pino-pretty` as a stream and `pino.destination` for the file sink. Output is unchanged: pretty logs to stderr, and NDJSON at mode 0600 under `LAUNCHFILE_LOG_DIR` when that is set.
