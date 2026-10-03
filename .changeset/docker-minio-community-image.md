---
"@launchfile/docker": patch
---

The `minio` and `s3` backing services now run `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` instead of `minio/minio:latest` (#585). MinIO no longer publishes community images, so `minio/minio:latest` no longer resolves and `docker compose up` failed at the pull. `pgsty/minio` is a maintained build of the same MinIO code, with the same `MINIO_ROOT_*` environment, `server /data` command and health endpoint. Existing `<app>-minio-data` and `<app>-s3-data` volumes are reused as-is: the data path is still `/data` and no migration is needed. A `version` range on `requires: minio` or `requires: s3` still reports "cannot be checked", because a `RELEASE.<timestamp>` tag names no semver version.
