/**
 * Exact-match lookup against a version manager's installed list.
 *
 * `rbenv versions --bare` and `pyenv versions --bare` both print one version
 * per line, so the lines are compared directly. A
 * `… --bare | grep -q "^${version}$"` pipe would be wrong twice over: it feeds
 * an untrusted version string to a shell, and `grep` reads it as a regex, so
 * every `.` matches any character — an installed `3x1` would satisfy a request
 * for `3.1` and silently skip the install.
 */

import { shell } from "../shell.js";

export async function isInstalled(
	tool: "rbenv" | "pyenv",
	version: string,
): Promise<boolean> {
	const result = await shell(tool, ["versions", "--bare"], {
		silent: true,
		allowFailure: true,
	});
	if (result.exitCode !== 0) return false;
	return result.stdout.split("\n").some((line) => line.trim() === version);
}
