import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { launchToCompose } from "../compose-generator.js";

interface ComposeService {
	entrypoint?: string[];
	command?: string;
	environment?: Record<string, string>;
}

type ComposeDoc = { services: Record<string, ComposeService> };

function serviceOf(doc: ComposeDoc, name: string): ComposeService {
	const service = doc.services[name];
	if (!service) throw new Error(`service ${name} missing from compose`);
	return service;
}

const refusals = (warnings: string[]) =>
	warnings.filter((w) => w.startsWith("refused:"));

/**
 * The `bucket` property promises a bucket an app can use at once. MinIO
 * creates none on its own, so the service must create it before serving
 * (D-64: provision, or refuse — never launch past an unmet precondition).
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
	const doc = parse(result.yaml) as ComposeDoc;

	it.each([
		["acme-minio", "MINIO_BUCKET"],
		["acme-s3", "S3_BUCKET"],
	])(
		"%s makes the bucket directory the app was told about",
		(service, envKey) => {
			const bucket = serviceOf(doc, "acme-app").environment?.[envKey];
			expect(bucket).toBe("acme");

			const backing = serviceOf(doc, service);
			expect(backing.command).toBeUndefined();
			expect(backing.entrypoint).toEqual([
				"sh",
				"-c",
				'mkdir -p "/data/$$1" && exec minio server /data',
				"sh",
				bucket,
			]);
		},
	);

	it("writes the positional reference escaped for compose interpolation", () => {
		// Compose turns `$$` into a literal `$`, so the shell sees `$1`. A bare
		// `$1` in the file would be subject to interpolation instead.
		expect(result.yaml).toContain('mkdir -p "/data/$$1"');
		expect(result.yaml).not.toMatch(/\/data\/\$1"/);
	});

	it("emits no refusal for a name that is a valid bucket name", () => {
		expect(refusals(result.warnings)).toEqual([]);
	});
});

describe("a name no S3 server accepts as a bucket refuses the component (D-64)", () => {
	it.each([
		["ab", "shorter than 3 characters"],
		["app-", "ends with a hyphen"],
	])("refuses the app named %s", (name, why) => {
		const result = launchToCompose(
			readLaunch(`
name: ${name}
components:
  web:
    image: acme/app:1
    requires:
      - type: s3
        set_env:
          S3_BUCKET: $bucket
`),
		);
		const doc = parse(result.yaml) as ComposeDoc;
		expect(doc.services[`${name}-web`]).toBeUndefined();
		expect(doc.services[`${name}-s3`]).toBeUndefined();
		expect(refusals(result.warnings)).toEqual([
			`refused: web requires a bucket this provider cannot create (s3: bucket "${name}" ${why}) — ` +
				"the bucket is named after the app, and S3 bucket names are 3 to 63 characters and " +
				"never end with a hyphen; rename the app, or supply the resource through the " +
				"provider's supplied-resource channel (D-56) — component skipped",
		]);
	});

	it("does not refuse a supplied resource, whose bucket this provider never creates", () => {
		const result = launchToCompose(
			readLaunch(`
name: ab
components:
  web:
    image: acme/app:1
    requires:
      - type: s3
        set_env:
          S3_BUCKET: $bucket
`),
			{
				resources: {
					s3: {
						properties: {
							url: "https://s3.example.com",
							access_key: "k",
							secret_key: "s",
							bucket: "uploads-prod",
							region: "eu-north-1",
						},
					},
				},
			},
		);
		expect(refusals(result.warnings)).toEqual([]);
		const doc = parse(result.yaml) as ComposeDoc;
		expect(serviceOf(doc, "ab-web").environment?.S3_BUCKET).toBe(
			"uploads-prod",
		);
	});
});
