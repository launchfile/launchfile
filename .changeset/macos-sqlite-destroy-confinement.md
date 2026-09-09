---
"@launchfile/macos-dev": patch
---

Confine `launchfile down --destroy` to the project directory when it removes a sqlite database file. `SqliteProvisioner.destroy()` deleted whatever absolute path `.launchfile/state.json` named, and that file lives inside the cloned repo and is parsed without validation — so a repository could ship a state file pointing `dbName` at any file on the machine and have it deleted. The path is now resolved and refused unless it sits under `<projectDir>/.launchfile/data/sqlite/`, the directory `provision()` writes to. A refused path prints a warning and teardown continues to the next resource, so a poisoned state file cannot wedge cleanup. Legitimate cleanup is unaffected.
