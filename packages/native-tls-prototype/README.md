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

The [Gitea proof fixture](examples/gitea/Launchfile) uses SQLite to isolate TLS switching. The shipped catalog file instead requires PostgreSQL and leaves its HTTP endpoint unnamed. This example adds the optional name `web` for readable selection; `tls` always binds to the entry containing it, including an unnamed entry. The proposed capability is:

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

`$listener.port` is valid only in the bound certificate's `set_env`; `$port` retains its resource-local meaning and is not synthesized on a certificate. A certificate named by two entries is an error in every mode. The normalized listener carries the effective protocol/port; URL-emitting expressions must use those effective values, while `$app.url` remains the separately supplied public origin. Until #391's provider path honors that rule, this adapter refuses affected sibling URL references.

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

## Deliberate limits

One selected public HTTP(S) endpoint per invocation. The Docker demonstration publishes only that endpoint; it is not a general multi-endpoint deployment engine. Certificate material is one leaf and its directly issuing root CA. Intermediate chains, ACME, renewal/reload, mTLS, non-HTTP TLS, shared certificates, and simultaneous listeners are excluded. Gitea's curl-based health probe is not assumed to exist in every image.

Certificate delivery already fits D-53 mode 1 through D-56, with an open resource type under D-46. The new Authors decision is whether an optional binding may change a sibling listener's effective declaration. A future vocabulary registration must land with the D-56 credential-list protection, never ahead of it. Feature negotiation and production integration remain unimplemented; old readers can discard this syntax.

The [catalog capability audit](../../../catalog/TLS-CAPABILITIES.md) records upstream-native TLS support separately from current declaration coverage. Candidate examples preserve catalog defaults and add proposed wiring; they are authoring/plan checks, not additional live deployment claims.

[Public HTTPS requirements (#446)](https://github.com/launchfile/launchfile/issues/446), [operator strictness (#444)](https://github.com/launchfile/launchfile/issues/444), and [variants (#447)](https://github.com/launchfile/launchfile/issues/447) are separate demonstrations. This package rejects their new contracts/options instead of silently implementing or discarding them. Ordinary provider warnings remain warnings.
