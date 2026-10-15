---
"@launchfile/docker": minor
---

Let a caller grant host capabilities through a policy (D-44, PROVIDERS.md §11).

`launchToCompose` takes a new `hostCapabilities` option: a policy that answers one request per capability entry — `requires` entries, the legacy `host:` block, and `supports` entries — with the compose service fields that grant it (`cap_add`, `cap_drop`, `security_opt`, `sysctls`, `devices`, `volumes`, `user`, `read_only`, `tmpfs`, `pids_limit`, `mem_limit`, `cpus`, `network_mode`, `privileged`), or a reason to refuse. The provider itself still grants nothing: without a policy a required entry refuses the component with the same message as before, and an optional one is still noted as ungranted. A grant lands on that component's service only, never implies `--privileged`, and is reported in the launch warnings beside refusals, so an operator sees what was granted as plainly as what was refused.
