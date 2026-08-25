import { readLaunch } from "@launchfile/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchToCompose } from "../compose-generator.js";
import {
	clearRegisteredSecrets,
	REDACTED,
	redactSecrets,
	registerDeclaredSecret,
	registerSecret,
	registerSecrets,
} from "../redact.js";
import { planReleases, type ReleaseExec, runReleases } from "../release.js";
import { shell } from "../shell.js";

beforeEach(() => {
	clearRegisteredSecrets();
});

describe("redactSecrets", () => {
	it("scrubs a registered secret from arbitrary text", () => {
		registerSecret("s3cret-value-abc");
		expect(redactSecrets("psql -c \"PASSWORD 's3cret-value-abc'\"")).toBe(
			`psql -c "PASSWORD '${REDACTED}'"`,
		);
	});

	it("scrubs every occurrence, not just the first", () => {
		registerSecret("s3cret-value-abc");
		expect(redactSecrets("s3cret-value-abc and s3cret-value-abc")).toBe(
			`${REDACTED} and ${REDACTED}`,
		);
	});

	it("scrubs a registered password nested inside its own connection URL", () => {
		registerSecret("longpassword123");
		expect(redactSecrets("postgresql://user:longpassword123@localhost:5432/db")).toBe(
			`postgresql://user:${REDACTED}@localhost:5432/db`,
		);
	});

	it("scrubs URL-embedded credentials that were never registered", () => {
		expect(redactSecrets("curl https://alice:hunter2@example.com/api")).toBe(
			`curl https://alice:${REDACTED}@example.com/api`,
		);
	});

	it("leaves a URL without credentials untouched", () => {
		const text = "curl http://localhost:3000/health";
		expect(redactSecrets(text)).toBe(text);
	});

	it("ignores values too short to be registered safely", () => {
		registerSecret("abc");
		expect(redactSecrets("abc def")).toBe("abc def");
	});

	it("applies no length floor to a declared secret", () => {
		registerDeclaredSecret("824193");
		expect(redactSecrets("pin 824193 rejected")).toBe(`pin ${REDACTED} rejected`);
	});

	it("rejects the empty string as a declared secret", () => {
		// An empty separator would splice REDACTED between every character.
		registerDeclaredSecret("");
		expect(redactSecrets("untouched")).toBe("untouched");
	});

	it("ignores non-string registry entries", () => {
		registerSecrets([undefined, null, "registered-secret-value"]);
		expect(redactSecrets("registered-secret-value")).toBe(REDACTED);
	});

	it("replaces the longest match first so no partial secret survives", () => {
		registerSecret("abcdefghij");
		registerSecret("abcdefghijklmnop");
		expect(redactSecrets("abcdefghijklmnop")).toBe(REDACTED);
	});
});

describe("compose generation registers what it generates", () => {
	it("registers a generated app secret and a backing-resource password", () => {
		const launch = readLaunch(`
name: acme
secrets:
  admin_token:
    generator: secret
components:
  app:
    image: acme/app:1
    requires:
      - postgres
    provides:
      - { protocol: http, port: 3000, exposed: true }
`);
		const result = launchToCompose(launch, { hostPorts: { app: 8080 } });
		const token = result.secrets.admin_token!;
		expect(token).toBeTruthy();
		expect(redactSecrets(`seed-admin --token ${token}`)).toBe(
			`seed-admin --token ${REDACTED}`,
		);

		const password = result.secrets.postgres!;
		expect(password).toBeTruthy();
		expect(redactSecrets(`psql ${password}`)).toBe(`psql ${REDACTED}`);
	});
});

describe("release output", () => {
	const TOKEN = "S3CR3T-LIVE-VALUE-0123456789abcdef";
	const yaml = `
name: acme
secrets:
  admin_token:
    generator: secret
components:
  app:
    image: acme/app:1
    provides:
      - { protocol: http, port: 3000, exposed: true }
    commands:
      release: "seed-admin --token $secrets.admin_token"
`;

	let out: string[];

	beforeEach(() => {
		out = [];
		const sink = (...args: unknown[]): void => {
			out.push(args.map(String).join(" "));
		};
		vi.spyOn(console, "log").mockImplementation(sink);
		vi.spyOn(console, "error").mockImplementation(sink);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const plan = (): ReturnType<typeof planReleases> =>
		planReleases(readLaunch(yaml), {
			services: { app: "acme-app" },
			hostPorts: { app: 8080 },
			secrets: { admin_token: TOKEN },
		});

	const okExec: ReleaseExec = async () => ({ exitCode: 0, stdout: "", stderr: "" });

	const failingExec: ReleaseExec = async () => ({
		exitCode: 1,
		stdout: `connecting with token ${TOKEN}`,
		stderr: `auth failed for ${TOKEN}`,
	});

	// The plan carries the $-resolved command because that is what gets
	// executed; the redaction has to happen at the sink, not in the plan.
	it("resolves the secret into the command it executes", () => {
		expect(plan()[0]!.command).toBe(`seed-admin --token ${TOKEN}`);
	});

	it("never echoes the resolved secret in the command it prints", async () => {
		await runReleases(plan(), {
			project: "acme",
			composeFile: "/tmp/none.yml",
			exec: okExec,
		});
		const printed = out.join("\n");
		expect(printed).not.toContain(TOKEN);
		expect(printed).toContain(`seed-admin --token ${REDACTED}`);
	});

	it("scrubs the secret from the failed command's stdout and stderr", async () => {
		await expect(
			runReleases(plan(), {
				project: "acme",
				composeFile: "/tmp/none.yml",
				exec: failingExec,
			}),
		).rejects.toThrow("deploy aborted");
		const printed = out.join("\n");
		expect(printed).not.toContain(TOKEN);
		expect(printed).toContain(`connecting with token ${REDACTED}`);
		expect(printed).toContain(`auth failed for ${REDACTED}`);
	});

	it("keeps the non-secret part of the output readable", async () => {
		await runReleases(plan(), {
			project: "acme",
			composeFile: "/tmp/none.yml",
			exec: okExec,
		});
		expect(out.join("\n")).toContain("seed-admin --token");
	});
});

describe("shell command echo", () => {
	let out: string[];

	beforeEach(() => {
		out = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			out.push(args.map(String).join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("scrubs a registered secret out of the echoed argv", async () => {
		registerSecret("registered-secret-value");
		await shell("sh", ["-c", "true # registered-secret-value"]);
		expect(out.join("\n")).not.toContain("registered-secret-value");
		expect(out.join("\n")).toContain(REDACTED);
	});

	it("scrubs a registered secret out of the failure message", async () => {
		registerSecret("registered-secret-value");
		await expect(
			shell("sh", ["-c", "exit 1 # registered-secret-value"], { silent: true }),
		).rejects.toThrow(REDACTED);
	});
});
