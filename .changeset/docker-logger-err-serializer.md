---
"@launchfile/docker": patch
---

Fix a secret leak in the docker provider's error logging. `logger.ts` configured pino's path-based `redact` but no `serializers.err`, so a caught `Error` logged through `span.logger.error({ err })` on span failure wrote its `message`/`stack` — and any property attached to it, such as `shell.ts`'s `result`/`display` — to stderr and the opt-in NDJSON file with any embedded credential intact (D-18, CWE-532). A new `serializers.err` runs pino's standard error serializer output through the provider's existing `redactSecrets()`, so a credential inside an error's text is masked the same way a `token` field already is. The construction-site scrubs in `shell.ts`/`release.ts` are unchanged — this is a second net for any error site that doesn't build its message through `redactSecrets` first.
