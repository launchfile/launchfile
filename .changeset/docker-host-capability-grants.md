---
"@launchfile/docker": minor
---

Let a caller grant host capabilities through a policy (D-44, PROVIDERS.md §11).

`launchToCompose` takes a new `hostCapabilities` option: a policy that answers one request per capability entry (`requires` entries, each key of the legacy `host:` block, and `supports` entries). It returns either a reason to refuse, or the compose service fields that grant the entry (`cap_add`, `cap_drop`, `security_opt`, `sysctls`, `devices`, `volumes`, `user`, `read_only`, `tmpfs`, `pids_limit`, `mem_limit`, `cpus`, `network_mode`, `privileged`) plus the properties the entry's `set_env` reads. A grant lands on that component's service only, never implies `--privileged`, and is reported as a `granted:` line beside the `refused:` lines. A grant is refused with a reason when it would make the compose file invalid (a named volume, or a second mount on a container path the service already mounts), or when it omits a property its entry's `set_env` reads. A `network_mode` grant takes the service off the project network.

Passing a policy is the caller's statement that the operator consented (SPEC.md § Host capabilities require user consent). `launchfile up` passes none.

Without a policy, two things change. A component whose legacy `host:` block sets `filesystem: read-only` or `filesystem: read-write` is now refused like the block's other keys, as PROVIDERS.md §11 requires; it was previously deployed. A legacy `docker: optional` is now noted as an ungranted optional capability, as its migrated `supports` entry is; it was previously silent. Every other refusal and note reads exactly as before.
