---
"@launchfile/docker": patch
---

Check the docker provider's `state.json` at the load boundary instead of casting it, and read the `launchfileHash` it records. A hand-edited state file that lost its `ports` key used to load without complaint and then crash `launchfile status` and `launchfile list` with a TypeError naming neither the file nor the key; `loadState` now checks every field, drops only the malformed ones with a warning naming the state file and the key, defaults `ports` to empty, and keeps unknown keys so a field written by a newer provider version survives a round trip. `up` recompares the recorded Launchfile hash and warns when the file was edited in place — the source guard cannot see that — then continues, so the edit-then-redeploy cycle is unchanged.
