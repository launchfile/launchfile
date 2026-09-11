---
"launchfile": patch
---

Fixed boolean CLI flags silently ignoring a `--flag=<value>` spelling. `launchfile bootstrap <app> --reveal=false` printed the sensitive capture it looked like it was suppressing, and `launchfile up . --dry-run=true` ran a real deploy — neither helper behind those flags reads the text after `=`, so the value meant nothing in one direction or the other. The CLI now names every bare boolean flag in one table and refuses the valued spelling before it dispatches a command: `--reveal takes no value, e.g. --reveal`, exit code 1. The `--flag=<value>` form still works for the flags that take a value (`--name`, `--component`, `--schema-path`, `--storage`).
