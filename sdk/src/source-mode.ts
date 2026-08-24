import type { NormalizedCommand, NormalizedComponent } from "./types.js";

/**
 * D-38 source-mode run resolution: precedence `dev` > `image` > `start`.
 *
 * A `dev` command is the explicit opt-in to source mode and always wins. With
 * no `dev`, an `image` keeps the component in artifact mode — a provider that
 * runs from source never falls back to a `start` that may assume image
 * internals it cannot reconstruct. With neither `dev` nor `image`, `start`
 * runs from source.
 *
 * Returns `undefined` when the component resolves to its artifact (image, no
 * `dev` override) or declares no run command at all.
 *
 * The `dev` branch opts in on *presence*, not on a non-empty command — a
 * declared `dev: ""` still resolves here rather than falling back to
 * `start`. Callers that pass the result straight to a shell must check for
 * an empty `command` themselves.
 */
export function resolveSourceRunCommand(
	component: NormalizedComponent,
): NormalizedCommand | undefined {
	if (component.commands?.dev) return component.commands.dev;
	if (component.image) return undefined;
	return component.commands?.start;
}

/**
 * D-38 source-mode prepare resolution: `install ?? build`.
 *
 * The caller owns the on-demand/caching decision (first launch or a detected
 * dependency change) — this only resolves which command applies.
 */
export function resolveSourcePrepareCommand(
	component: NormalizedComponent,
): NormalizedCommand | undefined {
	return component.commands?.install ?? component.commands?.build;
}
