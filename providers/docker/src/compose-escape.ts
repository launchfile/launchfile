/**
 * Compose interpolates `$VAR`, `${VAR}` and `${VAR:-default}` in every string
 * of the file it reads, from the environment of the `docker compose` process,
 * and reads `$$` as one literal `$`. A string this generator writes from
 * Launchfile text, or from a value resolved out of it, goes through one of
 * these two functions, so the operator's shell never fills a `$` the file
 * meant literally (#776).
 *
 * A string the provider authors itself (an entrypoint, a backing-service
 * healthcheck) is written already escaped and never passes through here, so
 * nothing is escaped twice.
 *
 * Arguments passed to `docker compose run`/`exec` on the command line are not
 * interpolated, so the bootstrap and release paths never use these.
 */

/** Escape every `$` once, so compose hands the value over unchanged. */
export function escapeForCompose(value: string): string {
	return value.replace(/\$/g, () => "$$");
}

/**
 * A shell slot (`commands.start`, `health.command`): D-12 reads `$$` as a
 * literal `$`, every other `$` is already literal, and the result is escaped
 * once for compose. `$VAR` and `$$VAR` both reach the shell as `$VAR`.
 * Launchfile references are not resolved here.
 */
export function shellSlotForCompose(command: string): string {
	return escapeForCompose(command.replace(/\$\$/g, () => "$"));
}
