/**
 * Runtime installer interface.
 */

export interface RuntimeInstaller {
	readonly runtime: string;

	/** Detect the version from project files (.nvmrc, .ruby-version, etc.) */
	detectVersion(projectDir: string): Promise<string | undefined>;

	/** Ensure the runtime version is installed */
	install(version: string): Promise<void>;

	/** Get any shell env modifications needed (PATH, etc.) */
	shellEnv(version: string): Promise<Record<string, string>>;
}
