---
"@launchfile/sdk": minor
---

Add the `tls:` certificate binding: a `provides` entry can name one `supports:` entry of type `certificate` on the same component, and while that binding is active the entry's **effective** listener protocol is `https` (D-next).

`tls: server-cert` is shorthand for `tls: { certificate: server-cert }`; both spellings parse, normalize and serialize, and are mirrored in `spec/schema/launchfile.schema.json`. The object form is strict — an unknown key inside it is an error, because a binding-level `port:` override is Left open and strip mode would accept one and silently drop it.

Five cross-field rules are hard validation errors, none of them visible per entry:

- the bound `provides` entry declares an HTTP-family listener (`http`, `https`, `ws`, `grpc`) — `tls:` on a `tcp` or `udp` entry is rejected, naming the entry and its protocol, on the family line D-60 rule 2 draws for `https-origin`;
- the named certificate exists in the **same component's** `supports:`;
- that entry declares `type: certificate`;
- no certificate is bound by two `provides` entries;
- a binding naming a `requires:` entry is rejected as out of scope, with a message pointing at the follow-up.

New API: `effectiveListener(entry, activeCertificates)` returns the declared and effective protocol/port for one `provides` entry — one definition, so validation and tooling read the declared value while every URL-emitting expression reads the effective one. `boundCertificate`, `certificateBindings` and the `CERTIFICATE` type constant come with it.

The registry gains `certificate: { cert_file, key_file }` — two app-filesystem paths and no address. `key_file` is credential-bearing whatever its vocabulary membership.

Every file that declares no `tls:` parses, validates and serializes exactly as before.
