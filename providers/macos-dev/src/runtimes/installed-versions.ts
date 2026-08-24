/**
 * Exact-match lookup against a version manager's installed list.
 *
 * `rbenv versions --bare` and `pyenv versions --bare` both print one version
 * per line. Matching those lines directly replaces a
 * `… --bare | grep -q "^${version}$"` pipe, which had two problems: it fed an
 * untrusted version string to a shell, and `grep` read it as a regex, so `3.1`
 * matched an installed `3.14` and the install was skipped.
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
