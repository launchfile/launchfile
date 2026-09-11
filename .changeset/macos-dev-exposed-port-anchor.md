---
"@launchfile/macos-dev": minor
---

Anchor the allocated host port on the component's first `exposed: true` endpoint, falling back to `provides[0]`.

`allocatePorts` read `component.provides?.[0]?.port` with no check on `exposed`, while `computeAppProperties` picked the component to publish by `p.exposed === true`. Two rules, one number. For `provides: [{port: 9000}, {port: 8080, exposed: true}]` the docker provider reported `8080` and macos-dev reported `9000` for the same file — the P-5 divergence, and it moved `$app.*`, `$components.<name>.*`, and the `PORT` the spawned process binds together, since this provider keeps one port per component.

No shipped catalog app moves: the four apps with more than one `provides` entry mark every entry `exposed: true`. The parameter type widens to `Array<{ port: number; exposed?: boolean }>`.
