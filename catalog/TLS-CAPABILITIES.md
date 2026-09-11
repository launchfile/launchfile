# Native TLS capability audit for RFC A

Audited 2026-09-09 against this repository's tested `catalog/apps` entries and primary upstream documentation/source. No shipping catalog application declarations were changed and no additional application deployment was run for this audit. Mapping examples use the revised experimental `$listener.port` namespace; listener coordinates are not certificate properties.

## Finding and evidence count

The catalog's missing conditional TLS declarations do **not** demonstrate missing upstream capability. Gitea, Grafana, Miniflux, and Vaultwarden all have documented native HTTPS configuration while their tested catalog files describe HTTP defaults. Grafana and Miniflux provide **two additional concrete app motivations beyond Gitea** for the proposed selected-listener capability. Vaultwarden provides a fourth capability example with an upstream recommendation caveat. ntfy is a fifth documented native-TLS app whose additional-listener behavior tests the proposal's limits.

This is a bounded sample, not a full 72-app census or five newly proven TLS deployments. Catalog metadata records successful baseline tests for Grafana (2026-04-11), Miniflux (2026-04-06), Vaultwarden (2026-04-06), and ntfy (2026-04-08). Gitea's native TLS arrangements already have separate live proof in the public prototype. Upstream capabilities and source were reviewed for the other applications; no native TLS health result is claimed for them.

The HTTP baseline declarations are correct under D-59 for the configuration represented. The omission is a way to express another supported application configuration and its coordinated wiring, not an incorrectly labeled existing listener. Do not insert the proposed `tls` syntax into the shipping catalog before its format/provider decisions.

## 1. Gitea — established live-proof example

- Catalog: `catalog/apps/gitea/Launchfile`, HTTP on port 3000 plus its independent SSH endpoint. Its `GITEA__server__ROOT_URL` already uses `$app.url`.
- Proposed certificate `set_env` mapping: `GITEA__server__PROTOCOL: https`, `GITEA__server__HTTP_PORT: $listener.port`, `GITEA__server__CERT_FILE: $cert_file`, `GITEA__server__KEY_FILE: $key_file`. Explicit HTTP/3000 defaults support switching back.
- Listener semantics: the server protocol selects HTTPS on the configured HTTP port. Gitea's separate redirect-server controls must not be confused with the selected listener; the prototype does not enable another listener. Native support does not imply that every deployment must terminate TLS in Gitea.
- Primary evidence: [HTTPS setup](https://docs.gitea.com/administration/https-setup/), [server configuration](https://docs.gitea.com/administration/config-cheat-sheet/#server-server), and the Launchfile native-TLS prototype's recorded seven-arrangement live proof.

## 2. Grafana — strong additional selected-listener example

- Catalog: `catalog/apps/grafana/Launchfile`, HTTP on 3000; `GF_SERVER_ROOT_URL` already uses `$app.url`.
- Proposed certificate `set_env` mapping:

```yaml
GF_SERVER_PROTOCOL: https
GF_SERVER_HTTP_PORT: $listener.port
GF_SERVER_CERT_FILE: $cert_file
GF_SERVER_CERT_KEY: $key_file
```

Grafana documents the `GF_<SECTION>_<KEY>` environment override rule and the server's protocol, port, certificate, and key options. Its [HTTPS guide](https://grafana.com/docs/grafana/latest/setup-grafana/set-up-https/) configures HTTPS on the existing default port 3000. [Configuration reference](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/#server).

The [HTTP server implementation](https://github.com/grafana/grafana/blob/main/pkg/api/http_server.go) constructs its TCP listener from the configured HTTP address/port and selects `Serve` versus `ServeTLS` from the protocol. Thus this configuration changes that listener's transport; it does not automatically add an HTTP redirect listener. An optional Unix socket is a separate feature. This establishes optional native TLS capability, not a mandatory public-HTTPS requirement. Public URL context remains independent of backend transport.

## 3. Miniflux — strong additional certificate-activated example

- Catalog: `catalog/apps/miniflux/Launchfile`, HTTP on 8080 with PostgreSQL; `BASE_URL` already uses `$app.url`.
- Proposed certificate `set_env` mapping:

```yaml
CERT_FILE: $cert_file
KEY_FILE: $key_file
PORT: $listener.port
```

The [configuration reference](https://miniflux.app/docs/configuration.html) documents the certificate/key paths. `PORT` configures `0.0.0.0:$PORT`; alternatively, `LISTEN_ADDR` selects explicit addresses. A single-address fixture is the bounded candidate for A; multiple addresses and `CERT_DOMAIN` automatic certificate acquisition are separate cases to exclude from this demonstration.

The [server implementation](https://github.com/miniflux/v2/blob/main/internal/http/server/server.go) confirms that `determineListenTargets` selects `modeTLS` when both certificate files are configured and `modeHTTP` otherwise; `startTLSServer` uses the same target address with `ServeTLS`. With one TCP address and no `CERT_DOMAIN`/systemd/socket mode, this replaces that listener's transport. The automatic-certificate path separately starts an HTTP ACME challenge listener and is outside the proposed fixture.

Crucially, Miniflux's `HTTPS` option controls secure cookies and HSTS; it is **not** the certificate/listener activation setting. The server enables that setting internally when it discovers TLS targets. Likewise `BASE_URL` describes publication context. These must not be counted as proof that the backend already uses TLS.

## 4. Vaultwarden — capability exists, with a recommendation caveat

- Catalog: `catalog/apps/vaultwarden/Launchfile`, HTTP on 80; `DOMAIN` already uses `$app.url`.
- Proposed certificate `set_env` mapping:

```yaml
ROCKET_TLS: '{certs="$cert_file",key="$key_file"}'
ROCKET_PORT: $listener.port
```

The [upstream HTTPS guide](https://github.com/dani-garcia/vaultwarden/wiki/Enabling-HTTPS) documents this native Rocket TLS configuration and its container example maps external 443 to internal 80. The [environment template](https://github.com/dani-garcia/vaultwarden/blob/main/.env.template) documents `ROCKET_PORT`, with Docker's default 80. This configures TLS on Rocket's chosen port, not an additional HTTP listener. Interpolated paths in the TOML-shaped value must be safely quoted or constrained by the adapter; certificate material must be delivered into the container.

Upstream recommends proxy termination rather than its native Rocket path. Preserve that caveat; available capability is not the recommended deployment. The web vault's browser cryptography also supplies separate public secure-context motivation, which must not be conflated with mandatory app-side TLS. The upstream full-chain deployment guidance exceeds A's current direct-leaf/root test scope. Avoid generalizing the wiki's historical algorithm limitations to untested current releases.

## 5. ntfy — additional-listener boundary, not another single-listener proof

- Catalog: `catalog/apps/ntfy/Launchfile`, HTTP on 80.
- Documented native settings: `NTFY_LISTEN_HTTPS` (an address such as `:8443`), `NTFY_CERT_FILE`, and `NTFY_KEY_FILE`. A proposed `set_env` mapping would use `NTFY_LISTEN_HTTPS: ':$listener.port'`, `NTFY_CERT_FILE: $cert_file`, and `NTFY_KEY_FILE: $key_file`.
- [Configuration documentation](https://docs.ntfy.sh/config/#config-options) lists each environment variable; its examples include simultaneous HTTP and HTTPS. The [server implementation](https://github.com/binwiederhier/ntfy/blob/main/server/server.go) independently starts an HTTP server when `ListenHTTP` is nonempty and an HTTPS server when `ListenHTTPS` is nonempty.
- Therefore merely supplying the HTTPS settings adds a TLS listener while default HTTP remains. Do not present that as proof of A's replacement semantics. A single-listener adapter would also need proven HTTP-disable wiring, or the author must declare a distinct supported topology; simultaneous listeners remain outside A's current demonstration. A public HTTPS URL alone does not select either arrangement.

## Existing-format catalog assessment

No native-TLS correction to the four existing HTTP declarations is justified: they describe the default deployments correctly. Grafana, Miniflux, and Vaultwarden already carry the appropriate public URL expression, as does Gitea. Adding cert-path variables without conditional activation/material fulfillment would make the catalog ambiguous and would not establish portable support.

One adjacent existing-format improvement is identifiable in ntfy: its catalog file omits `NTFY_BASE_URL`, while upstream documents that as the service's public-facing URL. `NTFY_BASE_URL: { default: $app.url }` is a normal publication-context mapping to consider separately, with the catalog's usual validation/runtime checks. It does not enable native TLS and is outside this A-focused change. No ntfy catalog edit was made.

## Review implication

Use a capability audit, not a search for unavailable syntax, when counting motivations. The strongest initial three-app evidence set is **Gitea + Grafana + Miniflux**. Vaultwarden corroborates availability while preserving its proxy recommendation; ntfy demonstrates why coordinated activation must specify replacement versus additional listeners. These examples justify evaluating A. Delivery already fits D-53 mode 1 via D-56; whether an optional binding may change a sibling listener declaration remains an Authors decision. Trust vocabulary, provider adoption, and advanced topologies are not established by this audit.

## Candidate authoring updates

The private [native TLS demonstration](../packages/native-tls-prototype/README.md) contains candidate files derived from the tested catalog entries for [Gitea](../packages/native-tls-prototype/examples/catalog/gitea/Launchfile), [Grafana](../packages/native-tls-prototype/examples/catalog/grafana/Launchfile), [Miniflux](../packages/native-tls-prototype/examples/catalog/miniflux/Launchfile), and [Vaultwarden](../packages/native-tls-prototype/examples/catalog/vaultwarden/Launchfile). They retain shipped database/storage/listener baselines, add explicit baseline port/protocol settings where appropriate, and show the proposed optional binding. Tests check baseline preservation, five arrangement plans, and changed-port wiring for all four. Only the separate Gitea proof has live deployment evidence; these candidate files have not been promoted into the catalog.
