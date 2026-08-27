---
"@launchfile/docker": patch
---

A backing service's volume is mounted where that service actually stores its data. Every `requires:`-provisioned service was given `<name>-data:/data` regardless of type — correct for redis, minio and s3, wrong for every other type this provider can provision. These images declare their own `VOLUME`, so Docker mounted an anonymous volume at the real data path and the named `<name>-data` volume sat at `/data` holding nothing. `docker compose down` discards anonymous volumes, so a `requires: postgres` app came back from `up`, `down`, `up` with an empty database — while `down` printed "Data volumes preserved." The paths now used are each image's own declared `VOLUME`: postgres `/var/lib/postgresql/data`, mysql and mariadb `/var/lib/mysql`, mongodb `/data/db`, clickhouse `/var/lib/clickhouse`, rabbitmq `/var/lib/rabbitmq`, elasticsearch `/usr/share/elasticsearch/data` (its image declares none; this is `path.data` under the image's WORKDIR). `memcache` is in-memory and now gets no volume at all instead of an unused one.

**Behavior change:** an app already running a non-redis backing service gets a different compose file, and its containers recreate on the next `up` with the volume mounted at the real data path. Data written before the upgrade lives in an anonymous volume and does not survive that recreate — it would not have survived any other `down` either. Back up anything you need (`docker compose exec <service> pg_dump …`) before upgrading a deployment whose data you care about.

The data path is a required field on each service definition, so a type added later cannot silently inherit a wrong default.

One consequence for postgres: `config.extensions` is applied by an init script that postgres runs only when its data directory is empty. Now that the data directory persists, adding an extension to a deployment that has already run does not apply it. Recreate that service's data volume, or add the extension by hand with `CREATE EXTENSION`.
