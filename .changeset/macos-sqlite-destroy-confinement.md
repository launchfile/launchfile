---
"@launchfile/macos-dev": patch
---

Confine `launchfile down --destroy` to the project directory when it removes a sqlite database file. `SqliteProvisioner.destroy()` deleted whatever absolute path `.launchfile/state.json` named, and that file lives inside the cloned repo and is parsed without validation — so a repository could ship a state file pointing `dbName` at any file on the machine and have it deleted. The path is now resolved through the filesystem and refused unless it really sits under `<projectDir>/.launchfile/data/sqlite/`, the directory `provision()` writes to. Both ends of the comparison go through `realpath`, anchored on the caller-supplied project directory, so a repo that ships the data directory as a symlink out of the project cannot smuggle a delete past a string-prefix check. A refused path prints a warning and teardown continues to the next resource, so a poisoned state file cannot wedge cleanup. Legitimate cleanup is unaffected.
