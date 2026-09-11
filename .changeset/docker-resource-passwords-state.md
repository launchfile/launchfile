---
"@launchfile/docker": patch
---

Backing-service passwords no longer share a namespace with declared secrets. `state.json` kept both in one `secrets` map: the values for names the Launchfile's top-level `secrets:` block declares, and the passwords this provider mints for the services it starts for `requires:` (`postgres`, `mysql`, `mariadb`, `mongodb`, `elasticsearch`, `minio-access`, `minio-secret`, `s3-access`, `s3-secret`, `rabbitmq`). That map is what `$secrets.<name>` resolves from, and the resolver does not check that a name was declared — so `$secrets.postgres` answered with the database password in any app that requires postgres, whether or not it declared a secret by that name. An app that did declare one collided outright: whichever value was generated first won, and rotating one rotated the "other".

Minted passwords now live in their own `resourcePasswords` state key, and every resolver context — compose generation, `release`, `bootstrap` — is built from the declared names alone. `$secrets.<name>` resolves a declared secret or nothing.

**Existing deployments migrate on the next `up`, and no password is re-minted.** A backing service fixes its password into its data volume at initialization, so each value is *moved* from `secrets` to `resourcePasswords` with its value unchanged, and the service comes back on its existing volume. The moved values keep registering with the redactor, so they stay masked in logs and captured output (D-18).

The one case that keeps a value in both maps is a Launchfile that declares a secret named after a resource type it also requires: the two meanings currently share one value, and separating them would either lock the database out or hand the app a secret it never stored. The migration warns, naming the app and the key, so the declared secret can be rotated deliberately.
