import { readLaunch } from "@launchfile/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { clearRegisteredSecrets, REDACTED, registerSecret } from "../redact.js";
import {
	DEFAULT_RELEASE_TIMEOUT_MS,
	dependencyOrder,
	planReleases,
	type ReleaseExec,
	runReleases,
} from "../release.js";

const multiYaml = `
name: acme
components:
  frontend:
    image: acme/frontend:1
    provides:
      - { protocol: http, port: 3000, exposed: true }
    depends_on:
      - backend
    commands:
      release: "frontend-migrate"
  backend:
    image: acme/backend:1
    provides:
      - { protocol: http, port: 4000, exposed: true }
    commands:
      release:
        command: "backend-migrate --url $app.url"
        timeout: "5m"
  worker:
    image: acme/worker:1
`;

describe("dependencyOrder", () => {
	it("puts depends_on targets before their dependents", () => {
		const launch = readLaunch(multiYaml);
		const order = dependencyOrder(launch);
		expect(order.indexOf("backend")).toBeLessThan(order.indexOf("frontend"));
		expect(order).toHaveLength(3);
	});

	it("keeps declaration order without dependencies", () => {
		const launch = readLaunch(`
name: acme
components:
  a: { image: "a:1" }
  b: { image: "b:1" }
`);
		expect(dependencyOrder(launch)).toEqual(["a", "b"]);
	});
});

describe("planReleases", () => {
	const services = {
		frontend: "acme-frontend",
		backend: "acme-backend",
		worker: "acme-worker",
	};

	it("plans only components declaring release, in dependency order", () => {
		const launch = readLaunch(multiYaml);
		const plan = planReleases(launch, {
			services,
			hostPorts: { frontend: 8080 },
			secrets: {},
		});
		expect(plan.map((p) => p.component)).toEqual(["backend", "frontend"]);
		expect(plan[0]!.service).toBe("acme-backend");
	});

	it("resolves $-expressions and parses the declared timeout", () => {
		const launch = readLaunch(multiYaml);
		const plan = planReleases(launch, {
			services,
			hostPorts: { frontend: 8080 },
			secrets: {},
		});
		const backend = plan.find((p) => p.component === "backend")!;
		expect(backend.command).toBe("backend-migrate --url http://localhost:8080");
		// SPEC.md § Command interpretation: the resolved string is handed to a
		// shell as one argument, not split into argv by the provider.
		expect(backend.argv).toEqual([
			"sh",
			"-c",
			"backend-migrate --url http://localhost:8080",
		]);
		expect(backend.timeoutMs).toBe(300_000);
	});

	it("applies the provider default timeout when none is declared", () => {
		const launch = readLaunch(multiYaml);
		const plan = planReleases(launch, { services, hostPorts: {}, secrets: {} });
		const frontend = plan.find((p) => p.component === "frontend")!;
		expect(frontend.timeoutMs).toBe(DEFAULT_RELEASE_TIMEOUT_MS);
	});

	it("throws on an unparseable timeout instead of substituting a default", () => {
		const launch = readLaunch(`
name: acme
image: acme:1
commands:
  release:
    command: "migrate"
    timeout: "5 minutes"
`);
		expect(() =>
			planReleases(launch, {
				services: { default: "acme" },
				hostPorts: {},
				secrets: {},
			}),
		).toThrow(/release \[default\]: invalid duration "5 minutes"/);
	});

	it("honors the component selection (D-41 start-set)", () => {
		const launch = readLaunch(multiYaml);
		const plan = planReleases(launch, {
			services,
			hostPorts: {},
			secrets: {},
			only: new Set(["backend"]),
		});
		expect(plan.map((p) => p.component)).toEqual(["backend"]);
	});

	it("skips components the compose generator skipped", () => {
		const launch = readLaunch(multiYaml);
		const plan = planReleases(launch, {
			services: { frontend: "acme-frontend" },
			hostPorts: {},
			secrets: {},
		});
		expect(plan.map((p) => p.component)).toEqual(["frontend"]);
	});
});

describe("runReleases", () => {
	const plan = [
		{
			component: "backend",
			service: "acme-backend",
			command: "backend-migrate",
			argv: ["backend-migrate"],
			timeoutMs: 300_000,
		},
		{
			component: "frontend",
			service: "acme-frontend",
			command: "frontend-migrate",
			argv: ["frontend-migrate"],
			timeoutMs: 60_000,
		},
	];

	it("runs each release as a one-shot compose run --rm with the plan timeout", async () => {
		const calls: { cmd: string; args: string[]; timeout: number }[] = [];
		const exec: ReleaseExec = async (cmd, args, opts) => {
			calls.push({ cmd, args, timeout: opts.timeout });
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await runReleases(plan, {
			project: "lf-acme",
			composeFile: "/tmp/c.yml",
			exec,
		});

		expect(calls).toHaveLength(2);
		expect(calls[0]!.cmd).toBe("docker");
		expect(calls[0]!.args).toEqual([
			"compose",
			"-p",
			"lf-acme",
			"-f",
			"/tmp/c.yml",
			"run",
			"--rm",
			"-T",
			"acme-backend",
			"backend-migrate",
		]);
		expect(calls[0]!.timeout).toBe(300_000);
		expect(calls[1]!.args).toContain("acme-frontend");
	});

	it("throws on the first non-zero exit and stops the plan (fails the deploy)", async () => {
		const calls: string[] = [];
		const exec: ReleaseExec = async (_cmd, args) => {
			calls.push(args[args.length - 2]!);
			return { exitCode: 1, stdout: "", stderr: "migration exploded" };
		};

		await expect(
			runReleases(plan, {
				project: "lf-acme",
				composeFile: "/tmp/c.yml",
				exec,
			}),
		).rejects.toThrow(/release \[backend\] failed with exit code 1/);
		expect(calls).toHaveLength(1);
	});

	describe("the error's attached output is redacted at the attach point", () => {
		afterEach(() => clearRegisteredSecrets());

		it("carries no registered secret on result.stdout/stderr — the span logger serializes the error whole", async () => {
			const secret = "release-planted-secret-77aa";
			registerSecret(secret);
			const exec: ReleaseExec = async () => ({
				exitCode: 1,
				stdout: `token=${secret}`,
				stderr: `auth failed: rejected ${secret}`,
			});

			const err = (await runReleases(plan, {
				project: "lf-acme",
				composeFile: "/tmp/c.yml",
				exec,
			}).catch((e: unknown) => e)) as Error & {
				result: { stdout: string; stderr: string };
			};

			expect(err.result.stdout).toBe(`token=${REDACTED}`);
			expect(err.result.stderr).toBe(`auth failed: rejected ${REDACTED}`);
			expect(JSON.stringify(err.result)).not.toContain(secret);
		});
	});
});

describe("command interpretation (SPEC.md § Command interpretation)", () => {
	const services = { default: "acme-app" };
	const plan = (command: string) =>
		planReleases(
			readLaunch(`version: launch/v1\nname: acme\ncommands:\n  release: ${JSON.stringify(command)}\n  start: serve\nimage: acme:1\n`),
			{ services, hostPorts: {}, secrets: {} },
		)[0]!;

	it("keeps shell operators intact instead of splitting them into argv", () => {
		// Splitting would send `&&` to the container as a literal argument and
		// run only the first command — the divergence from macos-dev this closes.
		const item = plan("rails db:migrate && rails db:seed");
		expect(item.argv).toEqual(["sh", "-c", "rails db:migrate && rails db:seed"]);
	});

	it("passes the command as exactly one argv element", () => {
		const item = plan("sed -i \"s/a/b/\" f.json; echo done");
		expect(item.argv).toHaveLength(3);
		expect(item.argv[2]).toBe('sed -i "s/a/b/" f.json; echo done');
	});

	it("still rejects a command that resolves to nothing", () => {
		expect(() => plan("   ")).toThrow(/empty string/);
	});
});
