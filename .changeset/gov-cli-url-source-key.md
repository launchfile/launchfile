---
"launchfile": patch
---

`launchfile up <url>` records the deployment under the URL itself instead of `catalog:<url>` (#613). `launchfile list` and the "Multiple deployments match" message now show a URL deployment's source without a `catalog:` prefix. Index rows already written as `catalog:<url>` need no migration: they match the next `up` of the same URL, which rewrites the row.
