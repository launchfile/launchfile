/**
 * Type declarations for the optional macOS dev provider.
 * The actual package is dynamically imported at runtime.
 *
 * Hand-maintained, and narrower than the package's own `LaunchUpOpts` — it
 * only has to cover what this CLI passes. Anything added here must exist
 * there; nothing here is checked against it.
 */
declare module "@launchfile/macos-dev" {
	export function launchUp(opts?: {
		projectDir?: string;
		dryRun?: boolean;
		detach?: boolean;
		withOptional?: boolean;
		noBuild?: boolean;
		/** Host paths for `content: operator` volumes (D-50 rule 1). */
		storage?: Record<string, string>;
	}): Promise<void>;

	export function launchDown(opts?: {
		destroy?: boolean;
		projectDir?: string;
	}): Promise<void>;

	export function launchStatus(opts?: {
		projectDir?: string;
	}): Promise<void>;

	export function launchEnv(opts?: {
		component?: string;
		projectDir?: string;
	}): Promise<void>;

	export interface BootstrapResult {
		component: string;
		command: string;
		ok: boolean;
		exitCode: number;
		captures: Record<string, string>;
		captureMeta: Record<string, {
			pattern: string;
			description?: string;
			sensitive?: boolean;
		}>;
		stdout: string;
		stderr: string;
	}

	export function launchBootstrap(opts?: {
		component?: string;
		projectDir?: string;
	}): Promise<BootstrapResult[]>;

	/**
	 * Build a redacted `LaunchError` against this provider's live secret
	 * registry (#44). The CLI calls it for a failure the provider reports
	 * instead of throwing — a bootstrap failure, which D-48 keeps out of deploy
	 * status — so the scrub still happens in the process that ran the command.
	 */
	export function macosLaunchError(input: {
		phase: import("@launchfile/sdk").LaunchPhase;
		key: string;
		message: string;
		app?: string;
		slug?: string;
		component?: string;
		command?: string;
		exitCode?: number;
		stdout?: string;
		stderr?: string;
		env?: Readonly<Record<string, unknown>>;
	}): import("@launchfile/sdk").LaunchError;

	/** Declared env var **names** — never a value (see `EnvKeyList`). */
	export function declaredEnvKeys(
		launch: import("@launchfile/sdk").NormalizedLaunch,
		component?: string,
	): Record<string, 0>;
}
