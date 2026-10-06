/**
 * Redis resource provisioner via Homebrew.
 */

import type { NormalizedRequirement } from "@launchfile/sdk";
import { shell, shellOk } from "../shell.js";
import type { ResourceState } from "../state.js";
import type {
	DestroyOpts,
	ProvisionOpts,
	ProvisionResult,
	ResourceProperties,
	ResourceProvisioner,
	ShellRunner,
} from "./types.js";
import { serverVersion, versionWarning } from "./version.js";

const DEFAULT_PORT = 6379;
const DEFAULT_HOST = "localhost";

export class RedisProvisioner implements ResourceProvisioner {
	readonly type = "redis";
	readonly #shell: ShellRunner["shell"];
	readonly #shellOk: ShellRunner["shellOk"];

	constructor(deps: Partial<ShellRunner> = {}) {
		this.#shell = deps.shell ?? shell;
		this.#shellOk = deps.shellOk ?? shellOk;
	}

	async isRunning(): Promise<boolean> {
		return this.#shellOk("redis-cli", ["ping"]);
	}

	async provision(
		req: NormalizedRequirement,
		_opts: ProvisionOpts,
		_existingState?: ResourceState,
	): Promise<ProvisionResult> {
		if (!(await this.isRunning())) {
			console.log("  Starting Redis via brew...");
			const started = await this.#shellOk("brew", [
				"services",
				"start",
				"redis",
			]);
			if (!started) {
				await this.#shell("brew", ["install", "redis"]);
				await this.#shell("brew", ["services", "start", "redis"]);
			}
		}

		const versionWarnings = req.version ? await this.#versionWarnings(req) : [];

		const port = DEFAULT_PORT;
		const resourceName = req.name ?? req.type;

		const properties: ResourceProperties = {
			url: `redis://${DEFAULT_HOST}:${port}/0`,
			host: DEFAULT_HOST,
			port,
			password: "",
		};

		const state: ResourceState = {
			type: "redis",
			name: resourceName,
			brewService: "redis",
			port,
		};

		return { properties, state, warnings: versionWarnings };
	}

	/** The `requires[].version` report, against the version the server reports. */
	async #versionWarnings(req: NormalizedRequirement): Promise<string[]> {
		const result = await this.#shell(
			"redis-cli",
			["-h", DEFAULT_HOST, "-p", String(DEFAULT_PORT), "INFO", "server"],
			{ allowFailure: true, silent: true },
		);
		const line = /^redis_version:(.*)$/m.exec(result.stdout)?.[1];
		const running =
			result.exitCode === 0 && line ? serverVersion(line) : undefined;
		const warning = versionWarning(
			req,
			`the Redis server on ${DEFAULT_HOST}:${DEFAULT_PORT}`,
			running,
		);
		return warning ? [warning] : [];
	}

	async destroy(_state: ResourceState, _opts: DestroyOpts): Promise<void> {
		// Redis is shared, don't stop the service
		// Could flush a specific database prefix, but not worth the complexity
	}
}
