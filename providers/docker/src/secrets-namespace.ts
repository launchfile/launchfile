/**
 * Which persisted values belong to which namespace.
 *
 * The docker provider persists two kinds of credential: values for the names a
 * Launchfile's top-level `secrets:` block declares, and passwords it mints
 * itself for the backing services it starts. Only the first kind is
 * addressable as `$secrets.<name>` (SPEC.md § Secrets). This module owns the
 * boundary between them — the reserved key vocabulary, the migration that
 * separates a pre-split state file, and the view that narrows a state map to
 * the declared names before it becomes a resolver context.
 */

/**
 * Every key the docker provider mints a backing-service password under. The
 * factories in `compose-generator.ts` type their lookups against this list, so
 * a factory cannot mint under a key the state shape does not know about, and
 * `migrateResourcePasswords` cannot miss one when moving an old state file's
 * values across.
 *
 * `redis`, `clickhouse` and `memcache` are absent on purpose: those images ship
 * with no generated credential, so nothing is minted for them.
 */
export const RESOURCE_PASSWORD_KEYS = [
	"postgres",
	"mysql",
	"mariadb",
	"mongodb",
	"elasticsearch",
	"minio-access",
	"minio-secret",
	"s3-access",
	"s3-secret",
	"rabbitmq",
] as const;

export type ResourcePasswordKey = (typeof RESOURCE_PASSWORD_KEYS)[number];

/**
 * Move an old state file's backing-service passwords out of `secrets` into
 * `resourcePasswords`, in place. Both maps are mutated; the returned strings
 * are warnings for the caller to surface.
 *
 * The values are **moved, never re-minted**. A backing service fixes its
 * password into its data volume at initialization, so a fresh password locks
 * the app out of its own database on the next run.
 *
 * A key the Launchfile also declares under `secrets:` is the collision this
 * split exists to end, and the one case where the value stays in both maps:
 * the two meanings currently share one value, and separating them now would
 * either lock the database out or hand the app a secret it never stored. The
 * warning names the app and the key so the operator can rotate deliberately.
 */
export function migrateResourcePasswords(
	secrets: Record<string, string>,
	resourcePasswords: Record<string, string>,
	declaredSecretNames: ReadonlySet<string>,
	appName: string,
): string[] {
	const warnings: string[] = [];
	for (const key of RESOURCE_PASSWORD_KEYS) {
		const carried = secrets[key];
		if (carried === undefined) continue;
		if (resourcePasswords[key] === undefined) resourcePasswords[key] = carried;
		if (declaredSecretNames.has(key)) {
			warnings.push(
				`${appName}: secret "${key}" shares its value with the ${key} backing service — ` +
					`state written before the two namespaces split. Rotate the declared secret to separate them.`,
			);
			continue;
		}
		delete secrets[key];
	}
	return warnings;
}

/**
 * The `$secrets.*` namespace a resolver context is allowed to answer from.
 *
 * SPEC.md § Secrets defines that namespace as the Launchfile's top-level
 * `secrets:` block: `$secrets.<name>` addresses a value the file declared.
 * `sdk/src/resolver.ts` performs a raw lookup on whatever map it is handed and
 * never checks that the name was declared, so the map itself is the boundary —
 * anything in it is reachable. This narrows a persisted state map to the
 * declared names before it becomes a resolver context.
 */
export function declaredSecrets(
	declared: Readonly<Record<string, unknown>> | undefined,
	stored: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
	const view: Record<string, string> = {};
	if (!declared || !stored) return view;
	for (const name of Object.keys(declared)) {
		const value = stored[name];
		if (value !== undefined) view[name] = value;
	}
	return view;
}
