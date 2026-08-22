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
