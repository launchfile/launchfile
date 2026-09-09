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
bun run prove
```

The plan command prints `status: "unresolved"` and the endpoint bound to the supplied public origin. It makes no network requests. Supplying an `https://` string does not establish a route. An HTTP public origin fails the requirement even though the app itself listens on HTTP.

`bun run prove` starts its own HTTP app fixture and HTTPS edge on ephemeral IPv4 loopback ports, generates a disposable CA, and probes the route using that CA. It removes its listeners, sockets, and certificate files in `finally`; it does not modify any trust store or existing service. The example image is illustrative: the proof runs the in-process fixture, not that image or a catalog application. A sample successful report is in [evidence/live-proof.json](evidence/live-proof.json).

## What the code demonstrates

`planPublicHttps(yaml, { publicUrl })` inspects the raw YAML through the SDK's size/alias-capped parser **before** legacy normalization. It removes only a validated public requirement, then delegates ordinary fields to the current SDK. This matters because the current reader can strip a `public` marker from a mixed `{ type: postgres, public: ... }` entry. Existing files without this proposal retain the SDK's normalization.

The requirement must be in `requires`, with exactly `{ public: { endpoint, scheme: https } }`. Its named target must exist exactly once in the declaring component, be explicitly exposed, and use an HTTP(S) listener. Cross-component references, duplicate requirements, top-level requirements ignored by multi-component normalization, native TLS bindings, and variants are refused.

Only the **primary endpoint** has publication context: the first exposed endpoint in component/endpoint declaration order, including non-HTTP endpoints when determining that order. Another endpoint cannot borrow `$app.url`. The prototype accepts public **origins** only; publication paths are outside this experiment. No provider routing is generated.

`probePublicHttps(plan, { ca, expectedBody })` is a separate observation step. It makes an HTTPS request with explicit certificate trust and hostname verification, requires status 200 and an exact expected response, captures the peer fingerprint/TLS protocol, and returns `observed-authenticated-route` evidence. It never follows redirects. A wall-clock deadline bounds connection setup and the whole response; a byte limit bounds the body. Neither function reports production deployment success or mutates the unresolved plan into a fulfilled deployment.

In the fixture, the expected response contains a fresh random value known to the local app. Seeing it through the edge, alongside the app's request counter, demonstrates that this controlled edge forwarded to that HTTP fixture. In general, the caller must establish what response to expect and how it relates to the intended app. A TLS certificate plus a caller-provided response string alone cannot establish deployment identity or routing ownership.

## Evidence and limits

The live proof covers public HTTP rejection, unresolved HTTPS planning, an authenticated HTTPS edge forwarding to HTTP, untrusted CA, wrong hostname, unavailable route, HTTP downgrade redirect, wrong application response, oversized body, timeout, and owned-resource cleanup. Unit/integration tests also cover malformed markers, scope, primary endpoint selection, ordinary-file preservation, unsupported concepts, response status, and probe policy bounds.

This is point-in-time evidence from one local client. It does not prove public DNS or Internet reachability, upstream ownership, sustained availability, browser authentication flows, secure-context behavior, or production provider fulfillment. The probe does not automate routing, provision certificates, follow redirects, manage ACME/renewal, test browser trust, or authenticate the edge-to-app hop. The demo's CA is ephemeral and explicitly passed; real private-root policy is unresolved. Negative cases fail directly, independently of the operator-strictness proposal.

The open RFC decision is **who** verifies the actual route, **when**, and against **which** app-specific evidence and failure semantics. D-58's baseline trust in supplied publication context remains unchanged outside this experiment. This stronger precondition is a proposal, not a consequence already imposed by listener clarification. No spec, schema, SDK, provider, catalog, or published CLI behavior changes here. A production design also needs feature negotiation: older tools must not silently ignore a required contract.

## Principle self-assessment

- **P-1/P-11:** The declaration can express an intrinsic app requirement; deployment policy and routing belong outside the file. This demo does not establish a concrete catalog app's intrinsic requirement.
- **P-2/P-4/P-7:** One optional declaration for the apps that need it; ordinary app files gain no required configuration.
- **P-3/P-6/P-8/P-9:** Typed, explicit YAML without conditionals; scope and failure checks run before permissive normalization.
- **P-5:** The experiment makes the translation/fulfillment boundary observable. Production provider fulfillment/refusal semantics remain an RFC decision.
- **P-10:** The requirement names the endpoint it constrains.
- **P-12:** The public origin is supplied by the caller; it is not embedded infrastructure configuration.
- **P-13/P-14:** Production behavior is unchanged. No claim that the proposed new requirement is safely understood by older tools.
