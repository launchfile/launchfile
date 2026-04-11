/**
 * Type declarations for the optional macOS dev provider.
 * The actual package is dynamically imported at runtime.
 */
declare module "@launchfile/macos-dev" {
	export function launchUp(opts?: {
		projectDir?: string;
		dryRun?: boolean;
		detach?: boolean;
		withOptional?: boolean;
		noBuild?: boolean;
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
