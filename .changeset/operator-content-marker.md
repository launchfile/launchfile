---
"@launchfile/sdk": minor
---

The D-50 `content: operator` storage marker. The SDK parses, round-trips, and serializes `content: operator` on a storage entry — the author's declaration that a volume's content is supplied by the operator at deploy time, not created empty by the provider — and rejects any other `content:` value. `launchfile validate` lists operator-supplied volumes in its privilege summary (an `operator-supplied storage:` line, `operatorStorage` in `--json`), so the marker is visible before anything runs. A new advisory lint warns when `persistent: false` sits beside the marker — operator-supplied content on a non-persistent volume is almost certainly a mistake.
