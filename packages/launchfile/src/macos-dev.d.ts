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
}
