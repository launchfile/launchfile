---
"@launchfile/sdk": patch
---

Fix `example` field on environment variables (D-31) being silently dropped by `readLaunch`/`writeLaunch`. `EnvVarObjectSchema`, the `EnvVar`/`NormalizedEnvVar` types, and the reader/writer normalization now carry `example` through parse and serialize, matching the published JSON Schema.
