# Public HTTPS requirement demonstration

Private, unshipped experiment for [RFC B (#446)](https://github.com/launchfile/launchfile/issues/446), split from [#314](https://github.com/launchfile/launchfile/issues/314). It is review evidence, not an accepted `launch/v1` extension or a production deployer. The listener-definition clarification in [PR #443](https://github.com/launchfile/launchfile/pull/443) has merged as D-59; RFC B remains a separate, unaccepted proposal.

```yaml
name: app
image: example/http-app:demo
provides:
  - { name: web, protocol: http, port: 3000, exposed: true }
requires:
  - public: { endpoint: web, scheme: https }
env:
  PUBLIC_URL: $app.url
```

Read this as “the public origin for my web endpoint needs HTTPS.” An ordinary HTTP application behind an HTTPS edge can meet that requirement. This declaration says nothing about native TLS, redirects, every-hop encryption, mTLS, or general browser secure-context requirements.

## Try it

Requires Bun, Node (for Vitest), and OpenSSL with `req -addext`. From the repository root, `bun install --frozen-lockfile` installs the workspace dependencies. Then, from `packages/public-https-prototype`:

```sh
bun run verify
bun run plan examples/Launchfile --public-url https://app.example
bun run plan examples/Launchfile --publication=no-channel
bun run plan examples/Launchfile --publication=after-apply
bun run plan examples/Launchfile --mode=translate
bun run prove
bun run census
```

The plan command reports what is knowable without making network requests. It validates the declaration even when no publication value exists. Supplying an `https://` string does not establish a route. A known HTTP public origin reports an unmet requirement; it does not mean the app file is invalid. Planning/translation commands return reports, not deployment success. A future deploying consumer must not report a mandatory unmet or unresolved requirement as fulfilled.

| Consumer context                    | Report          | Reason                          |
| ----------------------------------- | --------------- | ------------------------------- |
| No URL supplied                     | `unresolved`    | `publication-not-supplied`       |
| No publication channel              | `unresolved`    | `no-publication-channel`         |
| Address exists only after apply     | `unresolved`    | `address-available-after-apply`  |
| Translation-only output             | `not-evaluated` | `translation-only`              |
| Supplied HTTPS origin, no evidence  | `unresolved`    | `route-unverified`              |
| Supplied HTTP origin during a plan  | `unmet`         | `supplied-origin-not-https`      |

Without a URL, the report carries no invented URL. In translation mode, even a supplied syntactically valid URL does not trigger fulfillment evaluation. Malformed declarations or malformed supplied URLs still fail validation. The probe refuses unavailable context, translation reports, and unmet plans before making a request.

`bun run prove` starts its own HTTP app fixture and HTTPS edge on ephemeral IPv4 loopback ports, generates a disposable CA, and probes the route using that CA. It removes its listeners, sockets, and certificate files in `finally`; it does not modify any trust store or existing service. The example image is illustrative: the proof runs the in-process fixture, not that image or a catalog application. A sample successful report is in [evidence/live-proof.json](evidence/live-proof.json).

## What the code demonstrates

`planPublicHttps(yaml, { publicUrl?, publication?, mode? })` inspects the raw YAML through the SDK's size/alias-capped parser **before** legacy normalization. It removes only a validated public requirement, then delegates ordinary fields to the current SDK. This matters because the current reader can strip a `public` marker from a mixed `{ type: postgres, public: ... }` entry. Existing files without this proposal retain the SDK's normalization. The `publication` option can be `no-channel` or `after-apply`; `mode: translate` suppresses fulfillment evaluation. These are consumer context, not Launchfile fields.

Within this prototype, the requirement must be in `requires`, with exactly `{ public: { endpoint, scheme: https } }`. Its named target must exist exactly once in the declaring component, be explicitly exposed, and use an HTTP(S) listener. Cross-component references, duplicate requirements, top-level requirements ignored by multi-component normalization, native TLS bindings, and variants are refused. These are experimental scope choices, not accepted rules for app declarations.

This prototype accepts a requirement only on the app's **first exposed endpoint**, in component/endpoint declaration order, counting non-HTTP endpoints when fixing that order. This heuristic and the declaration restriction are the prototype's own choices. [D-58 rule 4](https://github.com/launchfile/launchfile/blob/main/spec/DESIGN.md#d-58-orchestrator-supplied-publication-context--app-under-an-owning-orchestrator) limits what a provider derives from one orchestrator-supplied URL to the app's *primary* endpoint; it does not define "primary" or prescribe this declaration-order heuristic, and it governs provider derivation rather than what an app may declare. Its Rejected section keeps per-endpoint publication context open under P-13. RFC #446's endpoint scope remains an unaccepted proposal. The prototype accepts public **origins** only; publication paths are outside this experiment. No provider routing is generated.

`probePublicHttps(plan, { ca, expectedBody })` is a separate observation step. It makes an HTTPS request with explicit certificate trust and hostname verification, requires status 200 and an exact expected response, captures the peer fingerprint/TLS protocol, and returns `observed-authenticated-route` evidence. It never follows redirects. A wall-clock deadline bounds connection setup and the whole response; a byte limit bounds the body. Neither function reports production deployment success or mutates the unresolved plan into a fulfilled deployment.

[D-56](https://github.com/launchfile/launchfile/blob/main/spec/DESIGN.md#d-56-orchestrator-satisfied-requiressupports--the-supplied-resource-channel) rejected provider-side verification of supplied resources: it changes translation into network work and duplicates the app healthcheck. The objection is about **which actor owns verification and what work a provider performs**, not whether a TLS probe can work. This optional experiment does not answer or override it; no current provider calls this probe. Requiring provider-owned network evidence for publication preconditions needs the explicit Author decision described below.

In the fixture, the expected response contains a fresh random value known to the local app. Seeing it through the edge, alongside the app's request counter, demonstrates that this controlled edge forwarded to that HTTP fixture. In general, the caller must establish what response to expect and how it relates to the intended app. A TLS certificate plus a caller-provided response string alone cannot establish deployment identity or routing ownership.

## Evidence and limits

The live proof covers a known public HTTP mismatch, missing publication context, no channel, address after apply, translation-only reporting, unresolved HTTPS planning, an authenticated HTTPS edge forwarding to HTTP, untrusted CA, wrong hostname, unavailable route, HTTP downgrade redirect, wrong application response, oversized body, timeout, and owned-resource cleanup. Unit/integration tests also cover malformed markers, the first-exposed endpoint heuristic, ordinary-file preservation, unsupported concepts, response status, and probe policy bounds.

This is point-in-time evidence from one local client. It does not prove public DNS or Internet reachability, upstream ownership, sustained availability, browser authentication flows, secure-context behavior, or production provider fulfillment. The probe does not automate routing, provision certificates, follow redirects, manage ACME/renewal, test browser trust, or authenticate the edge-to-app hop. The demo's CA is ephemeral and explicitly passed; real private-root policy is unresolved. Negative cases fail directly, independently of the operator-strictness proposal.

The open RFC has **two separately assessable Author decisions**. B1 adds a third fulfillment mode to D-53 point 1, which currently names only backing services and host capabilities; D-56 expressly declined a third mode. Any accepted B1 schema change must amend that normative count in the same change. B2 would require provider-side route verification: an explicit, category-scoped reversal of D-56's rejection of reachability probes, and an extension of D-58 rule 3 from syntactic URL refusal to network evidence. Neither follows from D-59. Authors can retain orchestrator-owned assertions for B1 without accepting B2; the optional probe demonstrates B2's mechanics, not a production policy decision.

[The motivation/precedent review](evidence/motivation.md) records two source-backed browser-origin motivations among 113 catalog files, a HedgeDoc counterexample, and the still-unmet 3+ governance bar. Existing marker coverage cannot measure demand for an unexpressible feature. Secure-context exceptions also mean those examples do not prove universal `scheme: https` requirements. The only catalog edit corrects Vaultwarden's web-vault/Web Crypto description, with its existing default unchanged. No spec, schema, SDK, provider, or published CLI behavior changes here. A production design also needs feature negotiation: older tools must not silently ignore a required contract.

## Verification coverage and prototype lifecycle

The [verification record](evidence/verification.md) distinguishes local runs from CI. Existing [CI workflows](../../.github/workflows/ci.yml) have no step that typechecks or tests this package or runs its live proof. Workspace installation can resolve its dependencies, but a green repository check list is not evidence that this prototype passed. Its current evidence is the explicitly recorded local `verify`, `prove`, and `census` runs; this PR adds no CI job.

The PR #451 author owns this disposable review artifact's updates and cleanup. It is a private workspace package, unimported by published packages, with no supported production API or service. Each proof invocation owns and cleans up its temporary listeners, sockets, and PKI; it installs no machine trust root. The intended review lifecycle is to retire the experiment after the RFC decision, or replace it through separately reviewed production work if accepted. Long-term maintenance or use by another package needs its own owner/CI decision.

Retiring the experiment means removing this package and regenerating the workspace lockfile with Bun. Deleting only the directory does **not** restore the previous repository tree: the lockfile records this workspace and dependency resolutions, and the independently reviewed Vaultwarden description correction remains a separate catalog change. No retirement or production integration is performed by this PR.

## Principle self-assessment

- **P-1/P-11:** D-59 tests whether the declaration changes with topology. A truthful app need stays invariant; its platform-owned fulfillment outcome may change. Browser-origin motivations do not automatically establish an invariant HTTPS-only requirement for all modes.
- **P-2/P-4/P-7:** One optional declaration for the apps that need it; ordinary app files gain no required configuration.
- **P-3/P-6/P-8/P-9:** Typed, explicit YAML without conditionals; scope and failure checks run before permissive normalization.
- **P-5:** The experiment makes the translation/fulfillment boundary observable. Production provider fulfillment/refusal semantics remain an RFC decision.
- **P-10:** The requirement names the endpoint it constrains.
- **P-12:** The public origin is supplied by the caller; it is not embedded infrastructure configuration.
- **P-13/P-14:** Production behavior is unchanged. The proposed third mode would amend a ratified boundary rather than be merely additive; old tools do not safely enforce it.
