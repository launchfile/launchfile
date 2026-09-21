---
"@launchfile/sdk": minor
---

Add `at:` on a `provides` entry: the host names a published HTTP-family listener answers at, relative to the app host ([#547](https://github.com/launchfile/launchfile/issues/547), D-next).

A value is `"@"` (the app host itself), one lowercase DNS label (`dash` → `dash.<app host>`), `"*"` (every name one label below the app host) or `"*.*"` (every name two labels below). `at: dash` is shorthand for `at: [dash]`; both parse to the list, so `Provides.at` is always a `string[]` after parsing, and the writer collapses a one-name list back to the string.

Four new validation errors:

- `at:` on an entry that is not `exposed: true`, or that speaks `tcp`/`udp`;
- a value listed twice on one entry;
- a value declared by two entries anywhere in the app — the message names both;
- `"@"` declared beside a primary endpoint (D-60 rule 3) that declares no `at:`, since that primary already answers at the app host.

`validate` warns when the primary endpoint declares `at:` without `"@"`: `$app.url` then names a host nothing in the app serves.

New API: `atDeclarations(launch)` lists every `provides` entry that declares `at:` — the list a provider must cover or refuse (D-next rule 5) — and `atEntryLabel(declaration)` names an entry in a message. The `AtDeclaration` type and the `AT_APP_HOST` constant (`"@"`) come with them.

Every file that declares no `at:` parses, validates and serializes exactly as before.
