---
"@launchfile/macos-dev": minor
---

Launch a component whose `provides` entry declares `at:`, and report the names it answers at ([#547](https://github.com/launchfile/launchfile/issues/547), D-68 rule 5).

A provider sets up the names a published entry declares or reports each one it did not set up; a silent launch is non-conformant. This provider starts each process on a local port with nothing in front that routes by host name, so every request reaches the listener with its `Host` intact and only name resolution is left to the operator. After the run summary, `up` prints one warning per declaring entry: the entry, the names under `localhost`, the local port requests arrive at, and the operator's options — map the name with a hosts file or DNS, or use a provider that routes host names. A dry run prints the same report without the port. Under a publication URL the report names the hosts under the supplied host and says that whatever routes that URL must send each name here.

New export: `atReports(launch, ports?, suppliedAppUrl?)`. Nothing changes for a Launchfile that declares no `at:`.
