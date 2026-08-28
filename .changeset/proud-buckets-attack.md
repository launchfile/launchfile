---
"@launchfile/docker": patch
---

A backing service's volume is mounted where that service actually stores its data. Every `requires:`-provisioned service was given `<name>-data:/data` regardless of type — correct for redis, minio and s3, wrong for every other type this provider can provision. These images declare their own `VOLUME`, so Docker mounted an anonymous volume at the real data path and the named `<name>-data` volume sat at `/data` holding nothing. `docker compose down` removes the container, and the next `up` builds a new one with a new anonymous volume — so a `requires: postgres` app came back from `up`, `down`, `up` with an empty database, while `down` printed "Data volumes preserved." The paths now used are each image's own declared `VOLUME`: postgres `/var/lib/postgresql/data`, mysql and mariadb `/var/lib/mysql`, mongodb `/data/db`, clickhouse `/var/lib/clickhouse`, rabbitmq `/var/lib/rabbitmq`, elasticsearch `/usr/share/elasticsearch/data` (its image declares none; this is `path.data` under the image's WORKDIR). `memcache` is in-memory and now gets no volume at all instead of an unused one.

**Behavior change:** an app already running a non-redis backing service gets a different compose file, and its containers recreate on the next `up` with the volume mounted at the real data path.

**Data written before this fix is not lost.** Each earlier `up` left it in an anonymous volume that is orphaned, not deleted. Recover it before upgrading. The commands below are the postgres case; every other affected type follows the same three steps — find the dangling volume, mount it into a throwaway container of that service's own image at that type's data path listed above, then dump it with that service's own tool (`mysqldump` for mysql and mariadb, `mongodump` for mongodb, and so on):

```sh
docker volume ls -f dangling=true            # find the orphan
docker run -d --name lf-recover \
  -v <volume-id>:/var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=unused postgres:16-alpine
docker exec lf-recover pg_dump -U launchfile <app-name> > backup.sql
docker rm -f lf-recover
```

If the deployment declared the `vector` (`pgvector`) or `postgis` extension in `config.extensions`, it ran a dedicated image — `pgvector/pgvector:pg16` or `postgis/postgis:16-3.4` — rather than stock postgres. Use that image in the recovery container, since the data directory belongs to it. Any other extension leaves the service on stock `postgres:16-alpine`, so the command above is already correct as written.

The upgrade itself does not touch the orphaned volume, and neither does `launchfile down --destroy`. That command runs `docker compose down -v --remove-orphans`: `-v` removes the named volumes plus the anonymous volumes attached to the containers being removed, and the orphan is attached to nothing, while `--remove-orphans` removes orphaned containers, not volumes. `docker volume prune` does remove the orphan, because it is dangling — recover it before you prune.

The data path is a required field on each service definition, so a type added later cannot silently inherit a wrong default.

One consequence for postgres: `config.extensions` is applied by an init script that postgres runs only when its data directory is empty. Now that the data directory persists, adding an extension to a deployment that has already run does not apply it. Recreate that service's data volume, or add the extension by hand with `CREATE EXTENSION`.
