/**
 * bunfig.toml preloads this file for `bun test` only. `bun run test` never
 * loads it, so reaching this code means Bun's built-in runner was used instead
 * of Vitest.
 *
 * The two runners disagree: Bun's ignores vitest.config.ts, and it shares one
 * module registry across every test file, so a `vi.mock()` in one file leaks
 * into the files loaded after it. A suite can pass under one runner and fail
 * under the other.
 */

process.stderr.write(
	[
		"",
		"  bun test is not the test runner for sdk.",
		"",
		"    use:  bun run test        (vitest run)",
		"",
		"  Bun's built-in runner ignores vitest.config.ts and shares module",
		"  mocks across files, so its results do not match CI.",
		"",
		"",
	].join("\n"),
);

process.exit(1);
