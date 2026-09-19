---
"launchfile": patch
---

`launchfile up --native` now registers the deployment as `unhealthy` when the macOS provider's health gate fails, the same row the docker branch writes for its gate. The provider leaves the app processes running on that path, so `status`, `logs` and `down` need the row to reach them; a failure before any process exists still records nothing.
