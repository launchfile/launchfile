/**
 * Type declarations for the optional macOS dev provider.
 * The actual package is dynamically imported at runtime.
 *
 * Hand-maintained and narrower than the package's own `LaunchUpOpts` — it
 * only declares what this CLI passes. A compiled type assertion,
 * `src/__tests__/macos-dev-declaration.types.ts`, checks these declarations
 * against `providers/macos-dev/src`, so a field that no longer exists there,
 * or whose type changed, fails the build.
 */
declare module "@launchfile/macos-dev" {
	export function launchUp(opts?: {
		projectDir?: string;
		dryRun?: boolean;
		detach?: boolean;
		withOptional?: boolean;
		noBuild?: boolean;
		/** D-41 component selector: these components plus their downward closure. */
		components?: string[];
		/** Host paths for `content: operator` volumes (D-50 rule 1). */
		storage?: Record<string, string>;
		/**
		 * The public URL of the app's primary endpoint when routing is owned
		 * upstream of this provider (D-58). Raw as the operator typed it — the
		 * provider normalizes or refuses it.
		 */
		appUrl?: string;
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
