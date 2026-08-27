/**
 * A backing service's volume must be mounted where that service actually keeps
 * its state. Mounted anywhere else it persists nothing, and silently: these
 * images declare their own VOLUME, so Docker mounts an anonymous volume at the
 * real path and `compose down` discards it, while the named volume survives
 * holding whatever the service never wrote there.
 *
 * The expected paths below are each image's own declared VOLUME (elasticsearch
 * excepted — it declares none, so its documented `path.data` stands in). Change
 * one only against the image, never to make a test pass.
 */

import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { launchToCompose } from "../compose-generator.js";

interface ComposeDoc {
	services: Record<string, { volumes?: string[] }>;
	volumes?: Record<string, unknown>;
}

const app = (type: string) => `
name: app
image: acme/app:1
provides:
  - { protocol: http, port: 3000, exposed: true }
requires:
  - type: ${type}
`;

const composeFor = (type: string): ComposeDoc =>
	parse(launchToCompose(readLaunch(app(type))).yaml) as ComposeDoc;

/** Resource type → the path that type's image stores its state at. */
const DATA_PATHS: Record<string, string> = {
	postgres: "/var/lib/postgresql/data",
	mysql: "/var/lib/mysql",
	mariadb: "/var/lib/mysql",
	mongodb: "/data/db",
	redis: "/data",
	clickhouse: "/var/lib/clickhouse",
	elasticsearch: "/usr/share/elasticsearch/data",
	minio: "/data",
	s3: "/data",
	rabbitmq: "/var/lib/rabbitmq",
};

describe("backing service data paths", () => {
	for (const [type, dataPath] of Object.entries(DATA_PATHS)) {
		it(`mounts ${type}'s volume at ${dataPath}`, () => {
			const doc = composeFor(type);
			const service = doc.services[`app-${type}`];
			expect(service?.volumes).toEqual([`app-${type}-data:${dataPath}`]);
			expect(doc.volumes).toHaveProperty(`app-${type}-data`);
		});
	}

	it("emits no volume for a service that holds nothing", () => {
		const doc = composeFor("memcache");
		expect(doc.services["app-memcache"]?.volumes).toBeUndefined();
		expect(doc.volumes ?? {}).not.toHaveProperty("app-memcache-data");
	});

	it("keeps the data path when a declared extension swaps the image", () => {
		const doc = parse(
			launchToCompose(
				readLaunch(`
name: app
image: acme/app:1
provides:
  - { protocol: http, port: 3000, exposed: true }
requires:
  - type: postgres
    config:
      extensions: [pgvector]
`),
			).yaml,
		) as ComposeDoc & { services: Record<string, { image?: string }> };

		expect(doc.services["app-postgres"]?.image).toBe("pgvector/pgvector:pg16");
		expect(doc.services["app-postgres"]?.volumes).toEqual([
			"app-postgres-data:/var/lib/postgresql/data",
		]);
	});
});
