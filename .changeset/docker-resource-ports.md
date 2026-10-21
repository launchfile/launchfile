---
"@launchfile/docker": patch
---

`ComposeOpts.resourcePorts` runs a provisioned `postgres`, `mysql` or `mariadb` on a container port other than the engine default (#568). The engine listens on the chosen port, its healthcheck probes that port, and the `port` and `url` properties publish it, so a run on a non-default port fails an entry that ignores `$port`. Each value must be an integer from 1 to 65535; anything else throws `InvalidResourcePortError`. Without the option the generated compose file is unchanged.
