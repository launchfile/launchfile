/**
 * Compile-time check that `src/macos-dev.d.ts` still matches the macOS dev
 * provider's source. Nothing here runs: `tsc --noEmit` (`bun run typecheck`)
 * fails when an assertion below does not hold.
 *
 * The provider is imported by relative path into its `src/`, not as
 * `@launchfile/macos-dev`: that package's `types` entry points at a `dist/`
 * that CI never builds, and the bare specifier resolves to the ambient
 * declaration under test.
 *
 * One direction only — every call the declaration allows must be one the
 * provider accepts, and every result the provider returns must satisfy the
 * declared result:
 *   - each declared option must exist on the provider's options, with a type
 *     the provider accepts, and must not be required there;
 *   - the provider's result must be assignable to the declared result.
 * A field the provider adds is not checked. The declaration only covers what
 * this CLI passes and reads, so a two-way check would fail every time the
 * provider grows an option the CLI does not use.
 */
import type * as Declared from "@launchfile/macos-dev";
import type {
	BootstrapResult as RealBootstrapResult,
	launchBootstrap as realLaunchBootstrap,
} from "../../../../providers/macos-dev/src/bootstrap.js";
import type {
	declaredEnvKeys as realDeclaredEnvKeys,
	macosLaunchError as realMacosLaunchError,
} from "../../../../providers/macos-dev/src/errors.js";
import type {
	launchDown as realLaunchDown,
	launchEnv as realLaunchEnv,
	launchStatus as realLaunchStatus,
	launchUp as realLaunchUp,
} from "../../../../providers/macos-dev/src/provider.js";

type Assert<T extends true> = T;

type Options<F extends (...args: never[]) => unknown> = NonNullable<
	Parameters<F>[0]
>;

/**
 * `true` when every declared key exists on the real options. Assignability
 * alone misses a renamed option: an all-optional object type accepts
 * unknown optional keys.
 */
type KnownKeys<Decl, Real> = [Exclude<keyof Decl, keyof Real>] extends [never]
	? true
	: false;

/**
 * `true` when a call typed against the declared function is a valid call of
 * the real one, and the real return value satisfies the declared return type.
 */
type Matches<
	Decl extends (...args: never[]) => unknown,
	Real extends (...args: never[]) => unknown,
> =
	KnownKeys<Options<Decl>, Options<Real>> extends true
		? [Parameters<Decl>] extends [Parameters<Real>]
			? [ReturnType<Real>] extends [ReturnType<Decl>]
				? true
				: false
			: false
		: false;

export type MacosDevDeclarationChecks = [
	Assert<Matches<typeof Declared.launchUp, typeof realLaunchUp>>,
	Assert<Matches<typeof Declared.launchDown, typeof realLaunchDown>>,
	Assert<Matches<typeof Declared.launchStatus, typeof realLaunchStatus>>,
	Assert<Matches<typeof Declared.launchEnv, typeof realLaunchEnv>>,
	Assert<Matches<typeof Declared.launchBootstrap, typeof realLaunchBootstrap>>,
	Assert<
		Matches<typeof Declared.macosLaunchError, typeof realMacosLaunchError>
	>,
	Assert<Matches<typeof Declared.declaredEnvKeys, typeof realDeclaredEnvKeys>>,
	Assert<
		[RealBootstrapResult] extends [Declared.BootstrapResult] ? true : false
	>,
];
