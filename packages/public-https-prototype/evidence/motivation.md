# Motivation and precedent review

Reviewed on 2026-09-09 in response to [the Steward's five gaps](https://github.com/launchfile/launchfile/issues/446#issuecomment-5604103172). This is evidence for an unaccepted proposal, not a catalog migration to new syntax.

## Census and its limits

`bun run census` reproduces the inventory and marker search recorded in [census.json](census.json): **113 catalog Launchfiles = 72 in `apps/` + 41 in `drafts/`**. Two entries have source-backed browser-origin motivations; HedgeDoc is an explicit counterexample.

| Entry                       | Verified upstream evidence                                                                                                      | Limit on the claim                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Vaultwarden                 | Its [README](https://github.com/dani-garcia/vaultwarden#usage) requires HTTPS/secure context for the web-vault's Web Crypto API.     | This affects web-vault operation beyond WebAuthn/U2F; it does not establish every client's transport needs.  |
| remote-claude-concentrator   | Upstream [passkey-only authentication](https://github.com/claudification/claudewerk#passkey-only-authentication) and [deployment](https://github.com/claudification/claudewerk#broker-deployment) documentation pair `RP_ID`/`ORIGIN` with the WebAuthn UI. | Upstream also supports `http://localhost:9999`; strict HTTPS is not invariant across all documented modes.    |
| HedgeDoc (excluded)         | Its [configuration reference](https://docs.hedgedoc.org/configuration/#hedgedoc-location) makes `CMD_PROTOCOL_USESSL` a URL-generation setting with false/true values. | Correctly tracking a deployment's scheme is not a declaration that the application requires HTTPS.          |

The upstream `claudification/remote-claude` URL now redirects to `claudification/claudewerk`; the catalog name is unchanged. The Launchfile wires `RP_ID: $app.host` and `ORIGIN: $app.url`, consistent with that current documentation. Neither RP-ID wiring alone nor an HTTPS example establishes a universal app-wide HTTPS precondition.

[WebAuthn](https://www.w3.org/TR/webauthn-3/#api) is a secure-context API. The [Secure Contexts standard](https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy) includes trustworthy loopback origins. These two apps motivate a browser-origin constraint; they do not prove that the narrower `scheme: https` spelling describes every supported mode. We must not change the declaration merely because the deployment target changes. The prototype intentionally does not invent a localhost exemption or general secure-context contract.

**Two of 113 is the present documented evidence set, not an upper bound on demand.** A missing declaration cannot establish absence of need when the format has no declaration for it. Conversely, the mechanism's absence does not prove any particular app requires HTTPS. No third motivation is fabricated. The [governance proposal template](https://github.com/launchfile/launchfile/blob/main/governance/GOVERNANCE.md#1-proposal) asks for 3+ real-app motivations; that evidence bar remains unmet unless the Authors explicitly allow this narrower evidence set or a third independently verified app is supplied.

The accompanying catalog-only edit corrects Vaultwarden's `DOMAIN` description to mention Web Crypto and the web vault. It adds no requirement and changes no default or routing behavior. The census command validates the edited Launchfile using the current SDK.

## Two distinct Author decisions

**B1 — a third fulfillment mode.** [D-53 point 1](https://github.com/launchfile/launchfile/blob/main/spec/DESIGN.md#d-53-host-capabilities-are-a-grantrefuse-fulfillment-mode-of-requiressupports--the-ratified-boundary) currently says:

> A `requires`/`supports` entry is either a **backing service** (bare string or `type:`) the provider *provisions and wires*, or a **host capability** (`host:`) the provider *grants, refuses, or warns on*.

Adding a publication precondition reopens that ratified two-mode boundary. If accepted, the change must amend D-53 from two fulfillment modes to three in the **same change** as the schema/SDK contract, not leave contradictory normative text. [D-56](https://github.com/launchfile/launchfile/blob/main/spec/DESIGN.md#d-56-orchestrator-satisfied-requiressupports--the-supplied-resource-channel) explicitly treated supplied backing-service satisfaction as the first mode and declined to create a third.

**B2 — optional network-verification policy.** D-56 rejected provider verification of supplied resources because it turns translation into a network operation and duplicates the app healthcheck. Requiring a provider to probe an upstream-owned publication route would explicitly reopen/reverse that rejected policy **for this new category**, and extend [D-58 rule 3](https://github.com/launchfile/launchfile/blob/main/spec/DESIGN.md#d-58-orchestrator-supplied-publication-context--app-under-an-owning-orchestrator) from syntactic URL validation to network evidence. It is not already required by D-58 or [D-59](https://github.com/launchfile/launchfile/blob/main/spec/DESIGN.md#d-59-providesprotocol-describes-the-components-own-listener).

Authors can assess B1 independently of B2: retain orchestrator ownership with an explicit fulfillment assertion, or adopt a narrowly scoped route-probe obligation with specified owner, vantage, trust policy, timing, retry budget, authentication and failure semantics. The private probe is an experiment for the second option; it does not select policy for production providers or alter D-56's existing backing-service channel.

## P-1 and the listener clarification

D-59 tests whether a **declaration** changes when the same app moves behind a TLS proxy. `provides.protocol` describes the app-side listener and stays `http` in that move. A truthful requirement likewise declares an invariant app need; it stays unchanged across targets. Whether the current deployment meets that need is a **fulfillment outcome** owned by the platform. That outcome may change with topology, but it is not a topology-dependent value placed in the file. This argument only works for a verified invariant need, not an operator's preference or an unsupported assertion that secure context always means HTTPS.
