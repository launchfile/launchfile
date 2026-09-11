---
"@launchfile/sdk": minor
---

Add the `https-origin` backing-service type: an app can declare that browsers must reach it at a public origin whose scheme is `https` (D-60).

A `requires`/`supports` entry of that type carries a new optional field, `endpoint`, naming the `provides` entry the origin fronts by its `name` (D-6). The field is parsed, normalized and serialized, so it survives a parse → serialize round trip, and is mirrored in `spec/schema/launchfile.schema.json`.

Two cross-field rules are hard validation errors, because neither can be seen per entry and a silently skipped declaration is the failure the type exists to remove:

- **Rule 2** — `endpoint` is required on an `https-origin` entry and rejected on any other type. The entry must sit on the component that owns the endpoint (top level in a file that declares `components:` is an error), the name must match exactly one `provides` entry on that component, and that entry must be `exposed: true` with an HTTP-family listener — `http`, `https`, `ws`, or `grpc`. Naming a `tcp` or `udp` entry fails, quoting the endpoint and its protocol.
- **Rule 3** — an app declares at most one `https-origin` entry.

The registry gains `https-origin: { url }` — one property, the public origin, the same string `$app.url` resolves to.

Every file that declares no `https-origin` entry parses, validates and serializes exactly as before.
