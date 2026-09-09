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

`verify` builds the SDK/Docker dependencies, checks TypeScript, and runs tests. Active certificate validation (including Compose compilation) requires OpenSSL on PATH; the adapter checks server purpose as well as key/chain/hostname validity. `plan` performs no deployment. `prove` requires Docker, OpenSSL, and the cached official `gitea/gitea:latest` image. It uses real Gitea with a persistent SQLite volume, disposable certificates, and its own loopback proxy servers. It removes the containers, volumes, certificates, and listeners it creates. It never changes system trust or restarts another service. See [the verification record](evidence/verification.md) for the tested image digest and results.

## Author and consumer experience

The [complete Gitea Launchfile](examples/gitea/Launchfile) contains explicit HTTP defaults plus this optional capability:

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
      GITEA__server__HTTP_PORT: $port
      GITEA__server__CERT_FILE: $cert_file
      GITEA__server__KEY_FILE: $key_file
```

“I serve HTTP on 3000; I can serve HTTPS with this certificate, configured here.” Supplying a certificate does not activate native TLS. Consumer selection coordinates the environment, effective protocol/port, certificate delivery, and health probe. Moving the certificate to `requires` makes native TLS mandatory. Explicit unsupported choices and missing/invalid active material fail.

`tls: server-cert` expands to `tls: { certificate: server-cert }`. Adding `port: 3443` to that object replaces the selected listener's port; it does not add a second listener. `$port` wires the selected value into the app's actual configuration. Explicit HTTP baseline settings allow a return from HTTPS even when the app persists configuration.

| Consumer mode | Public connection               | App listener | Certificate at app |
| ------------- | ------------------------------- | ------------ | ------------------ |
| off           | Direct HTTP                     | HTTP         | No                 |
| edge          | HTTPS terminates at proxy       | HTTP         | No                 |
| native        | Direct HTTPS                    | HTTPS        | Yes                |
| passthrough   | Client TLS session reaches app  | HTTPS        | Yes                |
| reencrypt     | Proxy opens authenticated TLS   | HTTPS        | Yes                |

For native planning, pass `--tls=native --url=https://localhost:33000 --cert=/absolute/server.pem --key=/absolute/server.key --ca=/absolute/root.pem`. The optional `--compose-file=/absolute/compose.yaml` validates material and emits an artifact with mode `0600`, refusing overwrite. No route or app is started. The command reports planning/compilation status rather than successful deployment.

## What the code demonstrates

- `src/planner.ts` validates proposed fields before the permissive SDK can discard them, selects one listener, and produces the existing normalized representation and resource coordinates.
- `src/docker.ts` uses the existing Compose generator, adds read-only certificate mounts, and supplies scheme-correct authenticated health checks. It refuses unsupported native-TLS sibling URL references affected by [#391](https://github.com/launchfile/launchfile/issues/391).
- `scripts/prove.ts` exercises seven sequential deployments: HTTP, edge, native, passthrough, re-encryption, a changed native port, and return to HTTP. Distinct edge/backend certificates identify where TLS terminates; negative probes check CA/hostname failures and prevent plaintext fallback.

## Deliberate limits

One selected public HTTP(S) endpoint per invocation. The Docker demonstration publishes only that endpoint; it is not a general multi-endpoint deployment engine. Certificate material is one leaf and its directly issuing root CA. Intermediate chains, ACME, renewal/reload, mTLS, non-HTTP TLS, shared certificates, and simultaneous listeners are excluded. Gitea's curl-based health probe is not assumed to exist in every image.

Certificate classification, trust vocabulary, feature negotiation, and production provider integration still need decisions. An old reader can strip unknown fields; a new version label alone does not prevent downgrade through that reader. This package only protects calls through its own validation boundary.

[Public HTTPS requirements (#446)](https://github.com/launchfile/launchfile/issues/446), [operator strictness (#444)](https://github.com/launchfile/launchfile/issues/444), and [variants (#447)](https://github.com/launchfile/launchfile/issues/447) are separate demonstrations. This package rejects their new contracts/options instead of silently implementing or discarding them. Ordinary provider warnings remain warnings.
