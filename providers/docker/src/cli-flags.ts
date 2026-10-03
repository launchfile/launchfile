/** True only for the exact long form `--<flag>`; short forms such as `-y` are not recognised. */
export function hasFlag(args: readonly string[], flag: string): boolean {
	return args.includes(`--${flag}`);
}
