/** Vocabulary source literal — see {@link RESOURCE_PROPERTY_VOCABULARY}. */
const VOCABULARY: Readonly<Record<string, readonly string[]>> = {
	postgres: ["url", "host", "port", "user", "password", "name"],
	mysql: ["url", "host", "port", "user", "password", "name"],
	sqlite: ["url", "path"],
	mongodb: ["url", "host", "port", "user", "password", "name"],
	redis: ["url", "host", "port", "password"],
	memcache: ["url", "host", "port"],
	rabbitmq: ["url", "host", "port", "user", "password"],
	elasticsearch: ["url", "host", "port"],
	minio: ["url", "host", "port", "access_key", "secret_key", "bucket"],
	clickhouse: ["url", "host", "port", "user", "password", "name"],
	kafka: ["url", "host", "port"],
	s3: ["url", "access_key", "secret_key", "bucket", "region"],
	"https-origin": ["url"],
	certificate: ["cert_file", "key_file"],
};

/**
 * Standard resource property vocabulary (SPEC.md § Resource Property
 * Vocabulary, D-46).
 *
 * Three forms of the same vocabulary exist: the SPEC.md prose table (canonical),
 * `spec/schema/resource-properties.json` (machine-readable registry, shipped in
 * this package's `schema/`), and this module (the lint check's runtime data).
 * `__tests__/resource-properties.test.ts` asserts all three agree, so drift
 * fails CI.
 *
 * The vocabulary for a known type is OPEN: providers may expose extension
 * properties, so a property outside this list is advisory-warned by lint,
 * never rejected. Unknown resource types have no entry here and are never
 * warned about (L-4: any string is accepted as a type).
 *
 * The map has a null prototype, so a lookup keyed by a caller-supplied resource
 * type resolves to `undefined` for `constructor`, `__proto__`, `toString`, and
 * every other `Object.prototype` key, rather than an inherited non-array value.
 */
export const RESOURCE_PROPERTY_VOCABULARY: Readonly<
	Record<string, readonly string[]>
> = Object.assign(Object.create(null), VOCABULARY);

/** One use in the source literal: the property keys it registers and whether it may be named more than once. */
interface UseEntry {
	readonly properties: readonly string[];
	readonly repeatable: boolean;
}

/** Use vocabulary source literal — see {@link RESOURCE_USE_VOCABULARY}. */
const USE_VOCABULARY: Readonly<Record<string, Readonly<Record<string, UseEntry>>>> = {
	redis: {
		db: { properties: ["url", "index"], repeatable: true },
		pubsub: { properties: [], repeatable: false },
		server: { properties: [], repeatable: false },
	},
	postgres: {
		database: { properties: ["url", "name"], repeatable: true },
		server: { properties: [], repeatable: false },
	},
	mysql: {
		database: { properties: ["url", "name"], repeatable: true },
		server: { properties: [], repeatable: false },
	},
};

/**
 * Standard resource use vocabulary (SPEC.md § Resource Use Vocabulary): for
 * each type that has one, the use tokens a `requires`/`supports` entry may
 * declare in `uses:`, each mapped to the property keys it registers under
 * `$<resource>.<use>.<property>`. An empty list means the use registers no
 * property of its own — the instance vocabulary already addresses it.
 *
 * The same three forms exist as for the property vocabulary — the SPEC.md
 * table (canonical), the `uses` key of `spec/schema/resource-properties.json`,
 * and this module — and `__tests__/resource-properties.test.ts` asserts all
 * three agree.
 *
 * Open, like the property vocabulary: a token outside this list is
 * advisory-warned by lint, never rejected by the schema. It is refused at
 * deploy time by any provider that does not recognise it, because no provider
 * can claim to cover a use it does not know. A type with no entry here has no
 * use vocabulary; its tokens are provider-defined and never warned about
 * (L-4).
 *
 * Null-prototype for the same reason as {@link RESOURCE_PROPERTY_VOCABULARY}.
 */
export const RESOURCE_USE_VOCABULARY: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = Object.assign(
	Object.create(null),
	Object.fromEntries(
		Object.entries(USE_VOCABULARY).map(([type, uses]) => [
			type,
			Object.assign(
				Object.create(null),
				Object.fromEntries(
					Object.entries(uses).map(([use, entry]) => [use, entry.properties]),
				),
			),
		]),
	),
);

/**
 * Whether the standard vocabulary lets `use` on `type` occur more than once
 * on one entry, each occurrence named (`- db: cache`). `false` for a use the
 * registry marks non-repeatable; `undefined` for a type or token outside the
 * registry, which has no standard answer (L-4) — the schema then accepts a
 * name and the provider decides, as for any provider-defined token.
 */
export function isRepeatableUse(type: string, use: string): boolean | undefined {
	const uses = Object.hasOwn(USE_VOCABULARY, type) ? USE_VOCABULARY[type] : undefined;
	const entry = uses && Object.hasOwn(uses, use) ? uses[use] : undefined;
	return entry?.repeatable;
}
