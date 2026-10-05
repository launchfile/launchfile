import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { launchToCompose } from "../compose-generator.js";

interface ComposeService {
	entrypoint?: string[];
	command?: string;
	environment?: Record<string, string>;
}

function serviceOf(yaml: string, name: string): ComposeService {
	const doc = parse(yaml) as { services: Record<string, ComposeService> };
	const service = doc.services[name];
	if (!service) throw new Error(`service ${name} missing from compose`);
	return service;
}

/**
 * The `bucket` property promises a bucket an app can use at once. MinIO
 * creates none on its own, so the service must create it before serving.
 */
describe("minio and s3 create the bucket the `bucket` property names", () => {
	const launch = readLaunch(`
name: acme
components:
  app:
    image: acme/app:1
    requires:
      - type: minio
        set_env:
          MINIO_BUCKET: $bucket
      - type: s3
        set_env:
          S3_BUCKET: $bucket
`);
	const result = launchToCompose(launch);

	it.each([
		["acme-minio", "MINIO_BUCKET"],
		["acme-s3", "S3_BUCKET"],
	])("%s makes the bucket directory the app was told about", (service, envKey) => {
		const bucket = serviceOf(result.yaml, "acme-app").environment?.[envKey];
		expect(bucket).toBe("acme");

		const backing = serviceOf(result.yaml, service);
		expect(backing.command).toBeUndefined();
		expect(backing.entrypoint).toEqual([
			"sh",
			"-c",
			'mkdir -p "/data/$1" && exec minio server /data',
			"sh",
			bucket,
		]);
	});
});
