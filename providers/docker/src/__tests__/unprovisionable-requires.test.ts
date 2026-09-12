/**
 * A `requires` entry this provider has no factory for, with nothing supplied
 * through the D-56 channel, REFUSES the component (PROVIDERS.md §10 item 5,
 * D-64) — the ordinary case of the `https-origin` and `certificate`
 * refusals. Starting the component anyway is the silent success the rule
 * forbids, so every test here asserts the outcome (the service is absent),
 * never only the message.
 *
 * The `kafka` factory lands alongside the refusal so `catalog/apps/posthog`
 * never goes red: its tests run the catalog entry itself through the generator.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readLaunch, selectionClosure } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { launchToCompose, resourcePropertyKeys } from "../compose-generator.js";

interface ComposeDoc {
	services: Record<
		string,
		{
			image?: string;
			command?: string[];
			environment?: Record<string, string>;
			healthcheck?: { test: string[] };
			volumes?: string[];
			depends_on?: Record<string, { condition: string }>;
		}
	>;
	volumes?: Record<string, unknown>;
}

function compose(
	yaml: string,
	opts: Parameters<typeof launchToCompose>[1] = {},
) {
	const result = launchToCompose(readLaunch(yaml), opts);
	return { ...result, doc: parse(result.yaml) as ComposeDoc };
}

const refusals = (warnings: string[]) =>
	warnings.filter((w) => w.startsWith("refused:"));

describe("requires: a type with no factory is refused (D-64)", () => {
	const APP = `
name: app
image: acme/app:1
requires:
  - type: snowflake
    set_env:
      SNOWFLAKE_URL: $url
`;

	it("refuses the component: no service, no image, no environment", () => {
		const { doc, images, warnings } = compose(APP);
		expect(doc.services.app).toBeUndefined();
		expect(images).toEqual([]);
		expect(refusals(warnings)).toHaveLength(1);
	});

	it("names the component, the entry, the type, and both ways out", () => {
		const [refusal] = refusals(compose(APP).warnings);
		expect(refusal).toBe(
			"refused: default requires a resource this provider cannot provision (snowflake) — " +
				"this provider has no provisioner for the type; supply it through the provider's " +
				"supplied-resource channel (D-56) or use a provider that provisions it — component skipped",
		);
	});

	it("names a named entry as name plus type", () => {
		const { warnings } = compose(`
name: app
image: acme/app:1
requires:
  - type: snowflake
    name: warehouse
`);
		expect(refusals(warnings)[0]).toContain('(warehouse (type "snowflake"))');
	});

	it("lists every unprovisionable entry of the component in one refusal", () => {
		const { doc, warnings } = compose(`
name: app
image: acme/app:1
requires:
  - type: snowflake
  - type: postgres
  - type: bigquery
`);
		expect(doc.services.app).toBeUndefined();
		// The postgres it could provision is not provisioned either — the
		// component is not launching, so nothing of it is emitted.
		expect(doc.services["app-postgres"]).toBeUndefined();
		const [refusal] = refusals(warnings);
		expect(refusal).toContain(
			"requires resources this provider cannot provision (snowflake; bigquery)",
		);
	});

	it("refuses sqlite — in the registry, but this provider has no factory for it", () => {
		const { doc, warnings } = compose(`
name: app
image: acme/app:1
requires:
  - type: sqlite
`);
		expect(doc.services.app).toBeUndefined();
		expect(refusals(warnings)[0]).toContain("(sqlite)");
	});

	it("emits the refusal and nothing else — no warn-and-skip line", () => {
		const { warnings } = compose(APP);
		expect(warnings).toEqual(refusals(warnings));
		expect(warnings.join("\n")).not.toContain("Unknown backing service");
	});
});

describe("the D-56 supplied-resource channel is checked first", () => {
	it("a supplied entry satisfies the type and nothing is refused", () => {
		const { doc, warnings } = compose(
			`
name: app
image: acme/app:1
requires:
  - type: snowflake
    set_env:
      SNOWFLAKE_URL: $url
`,
			{
				resources: {
					snowflake: {
						properties: { url: "https://acct.snowflakecomputing.com" },
					},
				},
			},
		);
		expect(refusals(warnings)).toEqual([]);
		expect(doc.services.app!.environment!.SNOWFLAKE_URL).toBe(
			"https://acct.snowflakecomputing.com",
		);
	});

	it("keys satisfaction by name, so a same-type entry under another key is still refused", () => {
		const { doc, warnings } = compose(
			`
name: app
image: acme/app:1
requires:
  - type: snowflake
    name: primary
  - type: snowflake
    name: replica
`,
			{
				resources: {
					primary: { properties: { url: "https://primary.example" } },
				},
			},
		);
		expect(doc.services.app).toBeUndefined();
		expect(refusals(warnings)[0]).toContain('(replica (type "snowflake"))');
		expect(refusals(warnings)[0]).not.toContain("primary");
	});
});

describe("the refusal is per component", () => {
	const TWO = `
name: app
components:
  web:
    image: acme/web:1
    requires:
      - type: postgres
  worker:
    image: acme/worker:1
    requires:
      - type: snowflake
`;

	it("siblings still launch with their own backing services", () => {
		const { doc, warnings } = compose(TWO);
		expect(doc.services["app-web"]).toBeDefined();
		expect(doc.services["app-postgres"]).toBeDefined();
		expect(doc.services["app-worker"]).toBeUndefined();
		expect(refusals(warnings)).toHaveLength(1);
		expect(refusals(warnings)[0]).toMatch(/^refused: worker /);
	});

	it("an unselected component's entry blocks nothing", () => {
		// Narrow `launch.components` to the selector's D-41 start-set before
		// generating, as a selecting caller does; a component outside it never
		// reaches the refusal — the same bounding §10 item 5 gives selection.
		const launch = readLaunch(TWO);
		const startSet = new Set(selectionClosure(launch, ["web"]).start);
		launch.components = Object.fromEntries(
			Object.entries(launch.components).filter(([n]) => startSet.has(n)),
		);
		const result = launchToCompose(launch);
		const doc = parse(result.yaml) as ComposeDoc;
		expect(doc.services["app-web"]).toBeDefined();
		expect(refusals(result.warnings)).toEqual([]);
	});
});

describe("what the refusal leaves alone", () => {
	it("supports: an unsatisfied optional resource still deploys, with the existing note (D-8)", () => {
		const { doc, warnings } = compose(`
name: app
image: acme/app:1
supports:
  - type: snowflake
    set_env:
      SNOWFLAKE_URL: $url
`);
		expect(doc.services.app).toBeDefined();
		expect(doc.services.app!.environment?.SNOWFLAKE_URL).toBeUndefined();
		expect(refusals(warnings)).toEqual([]);
		expect(warnings.join("\n")).toContain(
			"optional resource snowflake is not satisfied",
		);
	});

	it("an https-origin refusal keeps its own message and does not double-fire", () => {
		const { doc, warnings } = compose(`
name: app
image: acme/app:1
provides:
  - name: web
    protocol: http
    port: 80
    exposed: true
requires:
  - type: https-origin
    endpoint: web
  - type: snowflake
`);
		expect(doc.services.app).toBeUndefined();
		expect(refusals(warnings)).toHaveLength(1);
		expect(refusals(warnings)[0]).toContain("requires a public HTTPS origin");
	});

	it("a host-capability refusal keeps its own message and does not double-fire", () => {
		const { doc, warnings } = compose(`
name: app
image: acme/app:1
requires:
  - host: { container_runtime: docker }
  - type: snowflake
`);
		expect(doc.services.app).toBeUndefined();
		expect(refusals(warnings)).toHaveLength(1);
		expect(refusals(warnings)[0]).toContain("requires host capabilities");
	});

	it("output is unchanged for an app whose every type has a factory", () => {
		const { doc, warnings } = compose(`
name: app
image: acme/app:1
requires:
  - type: postgres
  - type: redis
`);
		expect(doc.services.app).toBeDefined();
		expect(doc.services["app-postgres"]).toBeDefined();
		expect(doc.services["app-redis"]).toBeDefined();
		expect(refusals(warnings)).toEqual([]);
	});
});

describe("docker kafka", () => {
	const KAFKA = `
name: events
image: acme/events:1
requires:
  - type: kafka
    set_env:
      KAFKA_HOSTS: $url
      KAFKA_HOST: $host
      KAFKA_PORT: $port
`;

	it("exposes the registry's url, host and port", () => {
		expect(resourcePropertyKeys().kafka).toEqual(
			expect.arrayContaining(["url", "host", "port"]),
		);
	});

	it("provisions one broker, gated on its readiness, with a named data volume", () => {
		const { doc, images } = compose(KAFKA);
		const broker = doc.services["events-kafka"]!;
		expect(broker.image).toBe("redpandadata/redpanda:v25.1.12");
		expect(images).toContain("redpandadata/redpanda:v25.1.12");
		expect(broker.volumes).toEqual([
			"events-kafka-data:/var/lib/redpanda/data",
		]);
		expect(doc.volumes).toHaveProperty("events-kafka-data");
		expect(broker.healthcheck!.test.join(" ")).toContain("/v1/status/ready");
		expect(doc.services.events!.depends_on).toEqual({
			"events-kafka": { condition: "service_healthy" },
		});
	});

	it("advertises the compose service name, so in-network clients get a dialable address", () => {
		const { doc } = compose(KAFKA);
		const command = doc.services["events-kafka"]!.command!;
		expect(command.slice(0, 2)).toEqual(["redpanda", "start"]);
		expect(command).toContain("PLAINTEXT://events-kafka:9092");
	});

	it("resolves set_env against the broker's properties", () => {
		const { doc } = compose(KAFKA);
		expect(doc.services.events!.environment).toMatchObject({
			KAFKA_HOSTS: "events-kafka:9092",
			KAFKA_HOST: "events-kafka",
			KAFKA_PORT: "9092",
		});
	});

	it("runs catalog/apps/posthog with KAFKA_HOSTS wired and nothing refused", () => {
		const launchfile = readFileSync(
			join(import.meta.dirname, "../../../../catalog/apps/posthog/Launchfile"),
			"utf8",
		);
		const { doc, warnings } = compose(launchfile);
		expect(refusals(warnings)).toEqual([]);
		expect(doc.services.posthog!.environment).toMatchObject({
			KAFKA_HOSTS: "posthog-kafka:9092",
			CLICKHOUSE_HOST: "posthog-clickhouse",
		});
		expect(doc.services["posthog-kafka"]).toBeDefined();
		expect(doc.services.posthog!.depends_on).toHaveProperty("posthog-kafka");
	});
});
