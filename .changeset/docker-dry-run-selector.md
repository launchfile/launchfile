---
"@launchfile/docker": patch
---

`up --dry-run` with a component selector names the start-set instead of previewing every component as if it would start ([#403](https://github.com/launchfile/launchfile/issues/403), D-41).

The printed YAML stays the whole project — `down` and `logs` read the persisted compose file later, so a selector never narrows it — and the header now says `(full project file)` under a selector. Beneath the YAML the dry run prints `Selector:`, `Would start:` (the selected components plus their downward `depends_on` closure, including members that publish no port) and `Not started:`. A dry run's address lines read "would be reachable at" rather than "is running at". Without a selector the header is unchanged.

`summaryLines` takes an optional sixth `verb` argument; `selectionLines` is new.
