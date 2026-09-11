import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isLaunchError,
	readLaunch,
	resolveSourcePrepareCommand,
	resolveSourceRunCommand,
	sourceErrorKey,
	UnboundOperatorStorageError,
} from "@launchfile/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { registerSensitiveEnv, registerSuppliedEnv } from "../env-secrets.js";
import {
	captureProcessLogs,
	declaredEnvKeys,
	inPhase,
	macosErrorKey,
	macosLaunchError,
} from "../errors.js";
import { clearRegisteredSecrets, REDACTED, registerSecret } from "../redact.js";
import { shellScript } from "../shell.js";

beforeEach(() => {
	clearRegisteredSecrets();
});

describe("macosErrorKey", () => {
	it("keys a record by project directory, not by app name", () => {
		// Two checkouts of the same app are two deployments for this provider —
		// it keeps state per directory and refuses --name. Sharing one record
		// would lose the loser's diagnosis (PROVIDERS.md §9).
		const a = macosErrorKey("/Users/dev/work/blog");
		const b = macosErrorKey("/Users/dev/review/blog");
		expect(a).not.toBe(b);
		expect(a).toMatch(/^src-[0-9a-f]{16}$/);
	});

	it("is the SDK derivation, so the CLI resolves the same key", () => {
		expect(macosErrorKey("/tmp/proj")).toBe(sourceErrorKey("/tmp/proj"));
	});
});

describe("redaction at capture", () => {
	it("scrubs a registered secret out of a captured tail", () => {
		registerSecret("sup3r-secret-password");
		const err = macosLaunchError({
			phase: "release",
			key: "demo",
			message: "release [web] failed with exit code 1",
			stderr: "FATAL: password authentication failed for sup3r-secret-password",
			stdout: "connecting as sup3r-secret-password",
		});

		expect(JSON.stringify(err.context)).not.toContain("sup3r-secret-password");
		expect(err.context.stderr).toContain(REDACTED);
	});

	it("scrubs credentials embedded in a captured command URL", () => {
		const err = macosLaunchError({
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

	it("registers a `sensitive: true` value, including a short one", () => {
		// D-18 says the author declared it sensitive; the registry's inference
		// floor must not overrule that, or the PIN lands in the record verbatim.
		const launch = readLaunch(`
name: pin-app
components:
  default:
    runtime: node
    commands:
      dev: node server.js
    env:
      DEVICE_PIN:
        default: "824193"
        sensitive: true
`);
		const component = launch.components.default!;
		registerSensitiveEnv(component.env, { DEVICE_PIN: "824193" });

		const err = macosLaunchError({
			phase: "run",
			key: "pin-app",
			message: "start failed",
			stderr: "auth failed: rejected pin 824193",
		});
		expect(err.context.stderr).toBe("auth failed: rejected pin [REDACTED]");
	});

	it("registers an operator-supplied value (D-52) before anything can echo it", () => {
		registerSuppliedEnv({ API_TOKEN: "op-supplied-1234" });
		const err = macosLaunchError({
			phase: "release",
			key: "demo",
			message: "migrate failed: token op-supplied-1234 rejected",
		});
		expect(err.context.message).not.toContain("op-supplied-1234");
	});

	it("keeps env var names and no env values (the sentinel)", () => {
		const launch = readLaunch(`
name: sentinel
components:
  default:
    runtime: node
    commands:
      dev: node server.js
    env:
      API_KEY:
        default: sentinel-value-never-on-disk
        sensitive: true
    requires:
      - type: postgres
        set_env:
          DATABASE_URL: $resource.url
`);
		const err = macosLaunchError({
			phase: "run",
			key: "sentinel",
			message: "start failed",
			env: declaredEnvKeys(launch),
		});

		expect(err.context.envKeys).toEqual(["API_KEY", "DATABASE_URL"]);
		expect(JSON.stringify(err.context)).not.toContain(
			"sentinel-value-never-on-disk",
		);
	});
});

describe("inPhase", () => {
	it("tags an untagged failure with its phase and the D-48 disposition", async () => {
		const err = await inPhase("release", { key: "demo" }, async () => {
			throw new Error("boom");
		}).catch((e: unknown) => e);

		expect(isLaunchError(err)).toBe(true);
		if (!isLaunchError(err)) throw new Error("unreachable");
		expect(err.context.phase).toBe("release");
		expect(err.context.disposition).toBe("failed-deploy");
		expect(err.context.provider).toBe("macos-dev");
	});

	it("lets the innermost phase win", async () => {
		const err = await inPhase("unknown", { key: "demo" }, () =>
			inPhase("prepare", { key: "demo" }, async () => {
				throw new Error("install failed");
			}),
		).catch((e: unknown) => e);

		expect(isLaunchError(err) && err.context.phase).toBe("prepare");
	});

	it("passes an expected refusal through unwrapped", async () => {
		// The CLI matches the D-50 refusals by `instanceof` to print their own
		// message; wrapping one would break that match and file an
		// operator-fixable precondition as a launch failure.
		const refusal = new UnboundOperatorStorageError([
			{ component: "web", volume: "library", flag: "--storage library=<path>" },
		]);
		const err = await inPhase("provision", { key: "demo" }, async () => {
			throw refusal;
		}).catch((e: unknown) => e);

		expect(err).toBe(refusal);
		expect(isLaunchError(err)).toBe(false);
	});
});

describe("source-mode capture (D-38 slots)", () => {
	const launch = readLaunch(`
name: srcapp
components:
  default:
    runtime: node
    source: .
    commands:
      install: exit 3
      build: echo artifact-build
      dev: exit 4
      start: echo artifact-start
`);

	it("captures a failing source prepare as the prepare slot", async () => {
		const component = launch.components.default!;
		const prepare = resolveSourcePrepareCommand(component);
		expect(prepare?.command).toBe("exit 3"); // install ?? build

		const err = await inPhase(
			"prepare",
			{ key: "srcapp", app: launch.name, component: "default" },
			() => shellScript(prepare!.command, { silent: true }),
		).catch((e: unknown) => e);

		expect(isLaunchError(err)).toBe(true);
		if (!isLaunchError(err)) throw new Error("unreachable");
		expect(err.context.phase).toBe("prepare");
		expect(err.context.disposition).toBe("failed-invocation");
		expect(err.context.exitCode).toBe(3);
		expect(err.context.command).toBe("exit 3");
	});

	it("captures a failing source run as the run slot", async () => {
		const component = launch.components.default!;
		const run = resolveSourceRunCommand(component);
		expect(run?.command).toBe("exit 4"); // dev ?? start

		const err = await inPhase(
			"run",
			{ key: "srcapp", app: launch.name, component: "default" },
			() => shellScript(run!.command, { silent: true }),
		).catch((e: unknown) => e);

		expect(isLaunchError(err) && err.context.phase).toBe("run");
		expect(isLaunchError(err) && err.context.exitCode).toBe(4);
	});

	it("captures the redacted command, never the raw one", async () => {
		registerSecret("dev-db-password-xyz");
		const err = await inPhase("release", { key: "srcapp" }, () =>
			shellScript("echo dev-db-password-xyz && exit 1", { silent: true }),
		).catch((e: unknown) => e);

		expect(isLaunchError(err)).toBe(true);
		if (!isLaunchError(err)) throw new Error("unreachable");
		expect(err.context.command).not.toContain("dev-db-password-xyz");
		expect(JSON.stringify(err.context)).not.toContain("dev-db-password-xyz");
	});
});

describe("captureProcessLogs", () => {
	it("attaches the component's own output to a run failure", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lf-macos-logs-"));
		await mkdir(join(dir, ".launchfile", "logs"), { recursive: true });
		await writeFile(
			join(dir, ".launchfile", "logs", "web.log"),
			"listening on 3000\nEADDRINUSE\n",
		);

		const err = await inPhase(
			"run",
			{ key: "demo", logs: () => captureProcessLogs(dir, ["web", "worker"]) },
			async () => {
				throw new Error("start failed");
			},
		).catch((e: unknown) => e);

		expect(isLaunchError(err)).toBe(true);
		if (!isLaunchError(err)) throw new Error("unreachable");
		// A component with no log file is skipped rather than recorded empty.
		expect(Object.keys(err.context.serviceLogs ?? {})).toEqual(["web"]);
		expect(err.context.serviceLogs?.web).toContain("EADDRINUSE");
	});

	it("returns nothing when no component has a log", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lf-macos-nologs-"));
		expect(await captureProcessLogs(dir, ["web"])).toBeUndefined();
	});
});
