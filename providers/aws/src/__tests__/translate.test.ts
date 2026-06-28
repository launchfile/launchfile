import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { translate } from "../translate.js";

function tf(yaml: string) {
	return translate(readLaunch(yaml));
}

describe("translate — foundation", () => {
	it("always emits the provider, VPC, subnets, and AMI data source", () => {
		const { hcl } = tf(`
version: launch/v1
name: my-app
runtime: node
commands:
  start: "node server.js"
`);
		expect(hcl).toContain('provider "aws"');
		expect(hcl).toContain('resource "aws_vpc" "main"');
		expect(hcl).toContain('resource "aws_subnet" "public_a"');
		expect(hcl).toContain('resource "aws_subnet" "public_b"');
		expect(hcl).toContain('data "aws_ami" "al2023"');
	});

	it("builds the component on EC2 from the contract (no Dockerfile)", () => {
		const { hcl, conformance } = tf(`
version: launch/v1
name: my-app
runtime: node
commands:
  build: "npm ci && npm run build"
  start: "node server.js"
`);
		expect(hcl).toContain('resource "aws_instance" "my_app_default"');
		expect(hcl).toContain("npm ci && npm run build"); // prepare slot in cloud-init
		expect(hcl).toContain("node server.js"); // run slot
		expect(
			conformance.mapped.some((m) => m.target === "aws_instance (cloud-init)"),
		).toBe(true);
	});

	it("neutralizes interpolation from user commands in cloud-init (correctness + injection)", () => {
		// A shell ${PORT} must survive as literal (valid Terraform), and a crafted
		// ${aws_vpc.main.id} must NOT resolve to a live reference inside user_data.
		const { hcl } = tf(`
version: launch/v1
name: shellapp
runtime: node
commands:
  start: "gunicorn --bind 0.0.0.0:\${PORT} \${aws_vpc.main.id}"
`);
		expect(hcl).toContain("0.0.0.0:$${PORT}");
		expect(hcl).toContain("$${aws_vpc.main.id}");
		// The raw, un-neutralized form must be absent from the user_data heredoc.
		expect(hcl).not.toContain("0.0.0.0:${PORT}");
	});
});

describe("translate — requires → managed services (P-1/P-11)", () => {
	it("maps postgres to aws_db_instance and wires set_env to its connection url", () => {
		const { hcl, conformance } = tf(`
version: launch/v1
name: my-app
runtime: node
requires:
  - type: postgres
    set_env:
      DATABASE_URL: $url
commands:
  start: "node server.js"
`);
		expect(hcl).toContain('resource "aws_db_instance" "my_app_postgres"');
		expect(hcl).toContain('engine = "postgres"');
		expect(hcl).toContain('resource "aws_db_subnet_group" "main"');
		// set_env DATABASE_URL resolves to an interpolated connection string.
		expect(hcl).toMatch(
			/postgres:\/\/launchfile:\$\{random_password\.my_app_postgres_pw\.result\}@\$\{aws_db_instance\.my_app_postgres\.address\}/,
		);
		expect(
			conformance.mapped.some(
				(m) =>
					m.field === "requires:postgres" && m.target === "aws_db_instance",
			),
		).toBe(true);
	});

	it("maps redis to aws_elasticache_cluster", () => {
		const { hcl } = tf(`
version: launch/v1
name: my-app
runtime: node
requires: [redis]
commands:
  start: "node server.js"
`);
		expect(hcl).toContain('resource "aws_elasticache_cluster" "my_app_redis"');
		expect(hcl).toContain('resource "aws_elasticache_subnet_group" "main"');
	});

	it("logs a gap (not a crash) for an unmappable resource type", () => {
		const { conformance } = tf(`
version: launch/v1
name: my-app
runtime: node
requires: [cassandra]
commands:
  start: "node server.js"
`);
		const gap = conformance.gaps.find((g) => g.field === "requires:cassandra");
		expect(gap).toBeDefined();
		expect(gap?.severity).toBe("workaround");
	});
});

describe("translate — provides → ALB", () => {
	it("fronts exposed components with an ALB, target group, and listener", () => {
		const { hcl, conformance } = tf(`
version: launch/v1
name: web
runtime: node
provides:
  - protocol: http
    port: 3000
    exposed: true
commands:
  start: "node server.js"
`);
		expect(hcl).toContain('resource "aws_lb" "main"');
		expect(hcl).toContain('resource "aws_lb_target_group" "web_default"');
		expect(hcl).toContain('resource "aws_lb_listener" "web_default"');
		expect(conformance.mapped.some((m) => m.target === "aws_lb (ALB)")).toBe(
			true,
		);
	});

	it("does not emit an ALB when nothing is exposed", () => {
		const { hcl } = tf(`
version: launch/v1
name: worker
runtime: node
commands:
  start: "node worker.js"
`);
		expect(hcl).not.toContain('resource "aws_lb" "main"');
	});

	it("uses the component health path for the target group check", () => {
		const { hcl } = tf(`
version: launch/v1
name: web
runtime: node
provides:
  - protocol: http
    port: 3000
    exposed: true
health:
  path: /healthz
commands:
  start: "node server.js"
`);
		expect(hcl).toContain('path = "/healthz"');
	});
});

describe("translate — storage → EBS", () => {
	it("creates an EBS volume and attachment per storage path", () => {
		const { hcl, conformance } = tf(`
version: launch/v1
name: app
runtime: node
storage:
  data:
    path: /var/lib/app
commands:
  start: "node server.js"
`);
		expect(hcl).toContain('resource "aws_ebs_volume" "app_default_data"');
		expect(hcl).toContain(
			'resource "aws_volume_attachment" "app_default_data"',
		);
		expect(conformance.mapped.some((m) => m.field === "storage:data")).toBe(
			true,
		);
	});
});

describe("translate — env → SSM (12-Factor III)", () => {
	it("writes env vars to SSM parameters", () => {
		const { hcl } = tf(`
version: launch/v1
name: app
runtime: node
env:
  LOG_LEVEL:
    default: info
commands:
  start: "node server.js"
`);
		expect(hcl).toContain(
			'resource "aws_ssm_parameter" "app_default_LOG_LEVEL"',
		);
		expect(hcl).toContain('value = "info"');
	});

	it("marks generated secrets as SecureString backed by random resources", () => {
		const { hcl } = tf(`
version: launch/v1
name: app
runtime: node
env:
  SESSION_SECRET:
    generator: secret
    sensitive: true
commands:
  start: "node server.js"
`);
		expect(hcl).toContain('type = "SecureString"');
		expect(hcl).toContain("random_password");
	});
});

describe("translate — RFC C / D-40 (specialization ignored, not errored)", () => {
	it("records the Dockerfile as ignored and still builds from the contract", () => {
		const { hcl, conformance } = tf(`
version: launch/v1
name: app
runtime: node
build:
  dockerfile: ./Dockerfile
  target: prod
commands:
  start: "node server.js"
`);
		// The Dockerfile is ignored; the EC2 instance is still emitted.
		expect(hcl).toContain('resource "aws_instance" "app_default"');
		expect(
			conformance.ignored.some(
				(i) => i.field === "build.dockerfile/target/args",
			),
		).toBe(true);
		// And it is NOT an error/gap.
		expect(conformance.gaps.some((g) => g.field.startsWith("build"))).toBe(
			false,
		);
	});

	it("gaps a prebuilt image with no portable contract", () => {
		const { conformance } = tf(`
version: launch/v1
name: app
image: nginx:latest
provides:
  - protocol: http
    port: 80
    exposed: true
`);
		expect(conformance.gaps.some((g) => g.field === "image")).toBe(true);
	});
});

describe("translate — multi-component ordering", () => {
	it("maps depends_on to a terraform dependency between instances", () => {
		const { hcl, conformance } = tf(`
version: launch/v1
name: stack
components:
  backend:
    runtime: node
    provides:
      - protocol: http
        port: 3000
    commands:
      start: "node api.js"
  frontend:
    runtime: node
    depends_on:
      - component: backend
        condition: healthy
    provides:
      - protocol: http
        port: 3001
        exposed: true
    commands:
      start: "node web.js"
`);
		expect(hcl).toContain("depends_on = [aws_instance.stack_backend]");
		expect(
			conformance.mapped.some((m) => m.field === "depends_on:backend"),
		).toBe(true);
	});
});
