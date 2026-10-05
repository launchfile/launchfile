---
"@launchfile/docker": patch
---

The `minio` and `s3` backing services now create the bucket their `bucket` property names before the server starts. MinIO creates no bucket on its own, so an app that read `$bucket` and used it at once got `NoSuchBucket` until someone created it by hand. A directory under the data path is a bucket, so the service entrypoint runs `mkdir -p /data/<bucket>` and then `minio server /data`; the bucket name is passed as an argument, not spliced into the script. Existing volumes are unaffected: `mkdir -p` is a no-op on a bucket that already exists.
