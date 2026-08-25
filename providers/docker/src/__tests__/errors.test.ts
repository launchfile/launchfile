import { isLaunchError, readLaunch } from "@launchfile/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { launchToCompose } from "../compose-generator.js";
import { registerSensitiveEnv, registerSuppliedEnv } from "../env-secrets.js";
import {
	declaredEnvKeys,
	dockerErrorKey,
	dockerLaunchError,
	inPhase,
} from "../errors.js";
import { clearRegisteredSecrets, REDACTED, registerSecret } from "../redact.js";
import { planReleases, runReleases } from "../release.js";
import { shell } from "../shell.js";

beforeEach(() => {
	clearRegisteredSecrets();
});

describe("dockerErrorKey", () => {
	it("uses the slug once one exists", () => {
		expect(dockerErrorKey({ slug: "ghost", source: "ghost" })).toBe("ghost");
	});

	it("synthesizes a stable key from the source before a slug exists", () => {
		const a = dockerErrorKey({ source: "/tmp/proj/Launchfile" });
		const b = dockerErrorKey({ source: "/tmp/proj/Launchfile" });
		expect(a).toBe(b);
		expect(a).toMatch(/^src-[0-9a-f]{16}$/);
		expect(a).not.toBe(dockerErrorKey({ source: "/tmp/other/Launchfile" }));
	});
});

describe("redaction at capture (§A)", () => {
	it("scrubs a registered secret out of a captured stderr tail", () => {
		registerSecret("sup3r-secret-password");
		const err = dockerLaunchError({
			phase: "release",
			key: "demo",
			message: "release [web] failed with exit code 1",
			stderr: "FATAL: password authentication failed for sup3r-secret-password",
			stdout: "connecting as sup3r-secret-password",
		});

		const serialized = JSON.stringify(err.context);
		expect(serialized).not.toContain("sup3r-secret-password");
		expect(err.context.stderr).toContain(REDACTED);
	});

	it("scrubs credentials embedded in a captured command URL", () => {
		const err = dockerLaunchError({
			phase: "release",
			key: "demo",
			message: "Command failed",
			command: "psql postgres://u:hunter2xyz@db:5432/app -c 'select 1'",
		});

		expect(err.context.command).not.toContain("hunter2xyz");
		expect(err.context.command).toBe(
			`psql postgres://u:${REDACTED}@db:5432/app -c 'select 1'`,
		);
	});

	it("derives the disposition from the phase, at capture time", () => {
		expect(dockerLaunchError({ phase: "release", key: "k", message: "m" }).context.disposition)
			.toBe("failed-deploy");
		expect(dockerLaunchError({ phase: "run", key: "k", message: "m" }).context.disposition)
			.toBe("failed-invocation");
		expect(dockerLaunchError({ phase: "bootstrap", key: "k", message: "m" }).context.disposition)
			.toBe("reported");
		expect(dockerLaunchError({ phase: "health", key: "k", message: "m" }).context.disposition)
			.toBe("failed-invocation");
	});
});

describe("registry coverage gap (§B)", () => {
	// The values a failing app is most likely to echo back are exactly the ones
	// the provider never generated: an author-declared credential and whatever
	// the operator handed over. Nothing registered either before this landed.
	const LAUNCHFILE = `
name: covergap
components:
  default:
    image: example/app
    env:
      API_KEY:
        default: "author-declared-api-key-9f31"
        sensitive: true
      PUBLIC_URL:
        default: "http://localhost"
`;

	it("registers a sensitive: true literal so it cannot reach a capture (D-18)", () => {
		const launch = readLaunch(LAUNCHFILE);
		launchToCompose(launch, {});

		const err = dockerLaunchError({
			phase: "run",
			key: "covergap",
			message: "boom",
			stderr: "auth rejected: author-declared-api-key-9f31",
		});

		expect(JSON.stringify(err.context)).not.toContain("author-declared-api-key-9f31");
	});

	it("leaves a non-sensitive literal alone", () => {
		const launch = readLaunch(LAUNCHFILE);
		launchToCompose(launch, {});
		const err = dockerLaunchError({
			phase: "run",
			key: "covergap",
			message: "boom",
			stderr: "using http://localhost",
		});
		expect(err.context.stderr).toContain("http://localhost");
	});

	it("registers operator-supplied required values before capture (D-52)", () => {
		const launch = readLaunch(LAUNCHFILE);
		launchToCompose(launch, {
			supplied: { default: { SMTP_PASSWORD: "operator-supplied-smtp-77c4" } },
		});

		const err = dockerLaunchError({
			phase: "release",
			key: "covergap",
			message: "boom",
			stdout: "SMTP auth failed for operator-supplied-smtp-77c4",
		});

		expect(JSON.stringify(err.context)).not.toContain("operator-supplied-smtp-77c4");
	});

	it("registers supplied values for components the generator later skips", () => {
		// No image and no build — the component is skipped, but the operator's
		// value was still handed to this process and must still be scrubbable.
		const launch = readLaunch(`
name: skipped
components:
  default:
    env:
      TOKEN:
        required: true
`);
		launchToCompose(launch, { supplied: { default: { TOKEN: "skipped-but-secret-51ab" } } });
		const err = dockerLaunchError({ phase: "run", key: "skipped", message: "skipped-but-secret-51ab" });
		expect(JSON.stringify(err.context)).not.toContain("skipped-but-secret-51ab");
	});

	it("registers a SHORT sensitive: true literal — no length floor on a declaration", () => {
		// A six-digit PIN is below MIN_SECRET_LENGTH. The author declared it
		// sensitive, so the declaration outranks the coincidence heuristic;
		// otherwise the PIN reaches an on-disk record in plaintext (CWE-532).
		const launch = readLaunch(`
name: shortpin
components:
  default:
    image: example/app
    env:
      DEVICE_PIN:
        default: "824193"
        sensitive: true
`);
		launchToCompose(launch, {});

		const err = dockerLaunchError({
			phase: "run",
			key: "shortpin",
			message: "boom",
			stderr: "rejected pin 824193",
		});

		expect(JSON.stringify(err.context)).not.toContain("824193");
		expect(err.context.stderr).toContain(REDACTED);
	});

	it("registers a SHORT operator-supplied value (D-52)", () => {
		const launch = readLaunch(`
name: shortsupplied
components:
  default:
    image: example/app
    env:
      OTP:
        required: true
`);
		launchToCompose(launch, { supplied: { default: { OTP: "9931" } } });

		const err = dockerLaunchError({
			phase: "release",
			key: "shortsupplied",
			message: "boom",
			stdout: "otp 9931 rejected",
		});

		expect(JSON.stringify(err.context)).not.toContain("9931");
	});

	it("registerSensitiveEnv and registerSuppliedEnv ignore what they are not given", () => {
		expect(() => registerSensitiveEnv(undefined, {})).not.toThrow();
		expect(() => registerSuppliedEnv(undefined)).not.toThrow();
	});
});

describe("envKeys — names only (§E)", () => {
	const launch = readLaunch(`
name: sentineled
components:
  default:
    image: example/app
    env:
      SENTINEL_TOKEN:
        default: "sentinel-value-b7e1-never-persist"
      OTHER:
        default: "plain"
    requires:
      - type: postgres
        set_env:
          DATABASE_URL: $url
`);

	it("captures declared env NAMES and no values", () => {
		const err = dockerLaunchError({
			phase: "run",
			key: "sentineled",
			message: "boom",
			env: declaredEnvKeys(launch),
		});

		expect(err.context.envKeys).toEqual(["DATABASE_URL", "OTHER", "SENTINEL_TOKEN"]);
		expect(JSON.stringify(err.context)).not.toContain("sentinel-value-b7e1-never-persist");
	});

	it("narrows to one component when asked", () => {
		expect(Object.keys(declaredEnvKeys(launch, "default")).sort()).toEqual([
			"DATABASE_URL",
			"OTHER",
			"SENTINEL_TOKEN",
		]);
		expect(declaredEnvKeys(launch, "nonexistent")).toEqual({});
	});
});

describe("inPhase", () => {
	it("passes a success through untouched", async () => {
		await expect(inPhase("run", { key: "k" }, async () => 42)).resolves.toBe(42);
	});

	it("tags a plain throw with the phase it happened in", async () => {
		const err = await inPhase("prepare", { key: "k", slug: "demo" }, async () => {
			throw new Error("build failed");
		}).catch((e: unknown) => e);

		expect(isLaunchError(err)).toBe(true);
		if (!isLaunchError(err)) throw err;
		expect(err.context.phase).toBe("prepare");
		expect(err.context.disposition).toBe("failed-invocation");
		expect(err.context.slug).toBe("demo");
	});

	it("lets an inner phase win over an outer one", async () => {
		const err = await inPhase("unknown", { key: "k" }, () =>
			inPhase("release", { key: "k" }, async () => {
				throw new Error("migration failed");
			}),
		).catch((e: unknown) => e);

		if (!isLaunchError(err)) throw err;
		expect(err.context.phase).toBe("release");
	});

	it("attaches the shell result and the REDACTED command form (§I)", async () => {
		registerSecret("shell-secret-value-1234");
		const err = await inPhase("run", { key: "k" }, () =>
			shell("sh", ["-c", "echo shell-secret-value-1234 >&2; exit 3"], { silent: true }),
		).catch((e: unknown) => e);

		if (!isLaunchError(err)) throw err;
		expect(err.context.exitCode).toBe(3);
		expect(err.context.command).toBe(`sh -c echo ${REDACTED} >&2; exit 3`);
		expect(err.context.stderr).toContain(REDACTED);
		expect(JSON.stringify(err.context)).not.toContain("shell-secret-value-1234");
	});

	it("keeps the release container's own output, redacted (§A)", async () => {
		const launch = readLaunch(`
name: relfail
components:
  default:
    image: example/app
    commands:
      release: "migrate"
`);
		const plan = planReleases(launch, {
			services: { default: "relfail" },
			hostPorts: {},
			secrets: { db: "release-secret-value-88" },
		});

		const err = await inPhase("release", { key: "relfail" }, () =>
			runReleases(plan, {
				project: "p",
				composeFile: "/tmp/none.yml",
				exec: async () => ({
					exitCode: 1,
					stdout: "",
					stderr: "FATAL: password authentication failed for release-secret-value-88",
				}),
			}),
		).catch((e: unknown) => e);

		if (!isLaunchError(err)) throw err;
		expect(err.context.phase).toBe("release");
		expect(err.context.disposition).toBe("failed-deploy");
		expect(err.context.exitCode).toBe(1);
		expect(err.context.command).toBe("migrate");
		expect(err.context.stderr).toContain(REDACTED);
		expect(JSON.stringify(err.context)).not.toContain("release-secret-value-88");
	});

	it("captures log tails only on failure", async () => {
		let called = 0;
		await inPhase("run", { key: "k", logs: async () => { called++; return { compose: "x" }; } },
			async () => "ok");
		expect(called).toBe(0);

		const err = await inPhase(
			"run",
			{ key: "k", logs: async () => ({ compose: "web-1  | boom" }) },
			async () => {
				throw new Error("start failed");
			},
		).catch((e: unknown) => e);

		if (!isLaunchError(err)) throw err;
		expect(err.context.serviceLogs?.compose).toBe("web-1  | boom");
	});

	it("survives a log capture that itself fails", async () => {
		const err = await inPhase(
			"run",
			{
				key: "k",
				logs: async () => {
					throw new Error("docker is gone");
				},
			},
			async () => {
				throw new Error("start failed");
			},
		).catch((e: unknown) => e);

		if (!isLaunchError(err)) throw err;
		expect(err.context.message).toBe("start failed");
		expect(err.context.serviceLogs).toBeUndefined();
	});
});
