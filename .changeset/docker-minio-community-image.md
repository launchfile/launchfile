---
"@launchfile/docker": patch
---

The `minio` and `s3` backing services now run `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` instead of `minio/minio:latest` (#585). MinIO no longer publishes community images, so `minio/minio:latest` no longer resolves and `docker compose up` failed at the pull. `pgsty/minio` is a maintained community fork of MinIO, with the same `MINIO_ROOT_*` environment, `server /data` command and health endpoint. The data path is still `/data`, so existing `<app>-minio-data` and `<app>-s3-data` volumes are mounted unchanged. A volume written by `RELEASE.2025-10-15T17-29-55Z`, the last upstream release, was read by the pinned fork with no migration. Data written by older upstream releases has not been tested: back up those volumes before upgrading. A `version` range on `requires: minio` or `requires: s3` still reports "cannot be checked", because a `RELEASE.<timestamp>` tag names no semver version.
