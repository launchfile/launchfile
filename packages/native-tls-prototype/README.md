# Native TLS capability demonstration

Runnable, private experiment for [RFC A #445](https://github.com/launchfile/launchfile/issues/445), split from [#314](https://github.com/launchfile/launchfile/issues/314). This is proposed syntax, not a `launch/v1` feature. It leaves the canonical parser, schema, providers, and CLI unchanged. The listener definition landed as D-59 in [#443](https://github.com/launchfile/launchfile/pull/443); native TLS capability still needs its separate RFC decision.

## Try it

Install from the repository root with `bun install --frozen-lockfile`, then use this package directory:

```sh
bun run verify
bun run plan examples/gitea/Launchfile --tls=off --url=http://localhost:33000
bun run plan examples/gitea/Launchfile --tls=edge --url=https://localhost:3443
bun run prove
```

`verify` builds the SDK/Docker dependencies, checks TypeScript, and runs tests; the consumer-verification tests use OpenSSL on PATH. Planning and Compose compilation do not read certificate files or check their validity, existence, or readiness. `prove` requires Docker, OpenSSL, and the cached official `gitea/gitea:latest` image. Its supplying consumer explicitly verifies certificates and exercises real Gitea with a persistent SQLite volume, disposable certificates, and owned loopback proxy servers. It removes the containers, volumes, certificates, and listeners it creates. See [the verification record](evidence/verification.md) for the tested image digest and results.

## Author and consumer experience

The [Gitea proof fixture](examples/gitea/Launchfile) uses SQLite to isolate TLS switching. Unlike the [shipped catalog file](../../catalog/apps/gitea/Launchfile), it omits `version: launch/v1`, replaces required PostgreSQL with SQLite, omits the separate SSH listener, and names the HTTP endpoint `web`. The [catalog-derived candidate](examples/catalog/gitea/Launchfile) preserves those shipped declarations, but has authoring/plan evidence only. None of the seven live deployments proves PostgreSQL or multiple listeners. `tls` binds to the entry containing it, including an unnamed entry. The proposed capability is:

```yaml
provides:
  - name: web
    protocol: http
    port: 3000
    exposed: true
    tls: server-cert
supports:
  - name: server-cert
    type: certificate
    set_env:
      GITEA__server__PROTOCOL: https
      GITEA__server__HTTP_PORT: $listener.port
      GITEA__server__CERT_FILE: $cert_file
      GITEA__server__KEY_FILE: $key_file
```

“I serve HTTP on 3000; I can serve HTTPS with this certificate, configured here.” Supplying a certificate does not activate native TLS. Consumer selection coordinates the environment, effective protocol/port, supplied certificate paths, and health probe. Moving the certificate to `requires` makes native TLS mandatory. Unsupported choices and missing binding paths fail before compilation; the provider does not inspect certificate contents or validity (D-56).

`tls: server-cert` expands to `tls: { certificate: server-cert }`. Adding `port: 3443` to that object replaces the selected listener's port; it does not add a second listener. `$listener.port` wires the selected value into the app's actual configuration. Explicit HTTP baseline settings allow a return from HTTPS even when the app persists configuration.

| Consumer mode | Public connection              | App listener | Certificate at app |
| ------------- | ------------------------------ | ------------ | ------------------ |
| off           | Direct HTTP                    | HTTP         | No                 |
| edge          | HTTPS terminates at proxy      | HTTP         | No                 |
| native        | Direct HTTPS                   | HTTPS        | Yes                |
| passthrough   | Client TLS session reaches app | HTTPS        | Yes                |
| reencrypt     | Proxy opens authenticated TLS  | HTTPS        | Yes                |

For native planning, pass `--tls=native --url=https://localhost:33000 --cert=/absolute/server.pem --key=/absolute/server.key --ca=/absolute/root.pem`. The optional `--compose-file=/absolute/compose.yaml` checks binding paths syntactically and emits an artifact with mode `0600`, refusing overwrite. It performs no certificate-content or network verification. `--ca` is consumer-selected trust for the prototype's health probe, not a server-presentation property; only `cert_file` and `key_file` reach the certificate resource. No route or app is started.

## What the code demonstrates

- `src/planner.ts` validates proposed fields before the permissive SDK can discard them, selects one listener, and produces the existing normalized representation and resource coordinates.
- `src/docker.ts` uses the existing Compose generator, adds read-only certificate mounts, and supplies scheme-correct authenticated health checks. It refuses unsupported native-TLS sibling URL references affected by [#391](https://github.com/launchfile/launchfile/issues/391).
- `src/certificate-verification.ts` is an optional supplying-consumer check used explicitly by the proof, separate from compilation. It checks purpose, key, chain, and hostname with bounded I/O. The provider does not gain a D-56 verification obligation.
- `src/redaction.ts` demonstrates `key_file` and all `*_key`/`*_key_file` values staying credential-bearing even if a future registry includes them. Tests use the provider redactor; the production registry remains unchanged.
- `scripts/prove.ts` exercises seven sequential deployments: HTTP, edge, native, passthrough, re-encryption, a changed native port, and return to HTTP. Distinct edge/backend certificates identify where TLS terminates; negative probes check CA/hostname failures and prevent plaintext fallback.

## Relationship to the revised RFC

The [revised #445](https://github.com/launchfile/launchfile/issues/445) and [issue follow-up](https://github.com/launchfile/launchfile/issues/445#issuecomment-5609929110) record these choices. They are evidence for an Authors decision, not ratified native-TLS semantics:

1. **Effective protocol:** the source declares the HTTP baseline. Native selection emits a normalized HTTPS listener and the selected port, consistent with D-59's meaning of `provides.protocol`. The optional binding's ability to change that declaration is still proposed.
2. **Port scope:** `$listener.port` is valid only in the bound certificate's `set_env`. Resource-local `$port` retains its meaning; certificates receive no synthetic `port`. A certificate named by two entries is invalid in every mode. This replaces the earlier experiment's resource-port workaround.
3. **Sibling URLs:** the proposed shared rule is that listener-derived URLs read the effective protocol/port. `$app.url` remains separate public-origin input. The production provider path in #391 is unchanged; this adapter refuses affected native sibling-URL references until that path can honor the rule. Refusal contains the implementation gap; it does not implement the shared URL rule.
4. **Verification owner:** planning and provider compilation check supplied binding/path syntax only. The separate supplying-consumer proof explicitly checks certificate bytes, trust, purpose, and hostname before calling the existing Docker provider, then probes the deployed route. A plan or compiled artifact alone proves neither authentication nor deployment success. The provider gains no material/readiness verification obligation; moving verification into it would require a separate policy decision.

## Deliberate limits

One selected public HTTP(S) endpoint per invocation. The Docker demonstration publishes only that endpoint; it is not a general multi-endpoint deployment engine. Certificate material is one leaf and its directly issuing root CA. Intermediate chains, ACME, renewal/reload, mTLS, non-HTTP TLS, shared certificates, and simultaneous listeners are excluded. Gitea's curl-based health probe is not assumed to exist in every image.

Certificate delivery already fits D-53 mode 1 through D-56, with an open resource type under D-46. The new Authors decision is whether an optional binding may change a sibling listener's effective declaration. A future vocabulary registration must land with the D-56 credential-list protection, never ahead of it. Feature negotiation and production integration remain unimplemented; old readers can discard this syntax.

The [catalog capability audit](../../catalog/TLS-CAPABILITIES.md) records upstream-native TLS support separately from current declaration coverage. Candidate examples preserve catalog defaults and add proposed wiring; they are authoring/plan checks, not additional live deployment claims.

[Public HTTPS requirements (#446)](https://github.com/launchfile/launchfile/issues/446), [operator strictness (#444)](https://github.com/launchfile/launchfile/issues/444), and [variants (#447)](https://github.com/launchfile/launchfile/issues/447) are separate demonstrations. This package rejects their new contracts/options instead of silently implementing or discarding them. Ordinary provider warnings remain warnings.

## Verification and lifecycle

No CI job builds, typechecks, or tests this package: `.github/workflows/ci.yml` names its target directories and does not name `packages/native-tls-prototype`. Green repository checks do not verify these 115 prototype tests or the live proof. SDK/Docker changes can invalidate the recorded results without a failing prototype check. Re-run `bun run verify` before citing test results and `bun run prove` before claiming fresh live-deployment evidence; record the runtime and dependency versions in [the verification record](evidence/verification.md).

The RFC/PR author owns keeping this demonstration reproducible while #445 is under consideration and submitting its removal when the Authors decide #445 in either direction. Remove `packages/native-tls-prototype/` and regenerate `bun.lock`; retain the evidence through the PR's immutable commits. An accepted design needs a separately reviewed production implementation, not promotion of this package. The accompanying `catalog/TLS-CAPABILITIES.md` is an additional documentation change outside the package; retire its proposal-specific candidate links with the prototype, retaining any generally useful catalog findings only through a separate catalog review. No compatibility or continuing maintenance guarantee is made for this experiment.
