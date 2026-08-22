/**
 * Parse a `repository` field value into its origin URL and baseline ref.
 *
 * On a git-hosted URL, everything after the first `#` is a git ref — a
 * branch, tag, or commit SHA (SPEC.md § Repository, D-43). A bare URL means
 * the repository's default branch. The fragment rule is defined for
 * git-hosted URLs only; callers decide whether the URL is git-hosted — this
 * helper only splits.
 *
 * The baseline ref is a default, never a lock: an orchestrator-supplied
 * source always overrides it (PROVIDERS.md § Source acquisition).
 */

export interface RepositoryRef {
	/** Origin URL with the fragment removed */
	url: string;
	/** Baseline ref (branch, tag, or commit SHA); undefined = default branch */
	ref?: string;
}

export function parseRepository(repository: string): RepositoryRef {
	const hash = repository.indexOf("#");
	if (hash === -1) return { url: repository };
	const url = repository.slice(0, hash);
	const ref = repository.slice(hash + 1);
	if (ref === "") return { url };
	return { url, ref };
}
