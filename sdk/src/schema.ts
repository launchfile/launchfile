/**
 * Zod validation schemas for the Launchfile format
 *
 * Handles both shorthand (scalar) and full (object) forms.
 * Use `LaunchSchema` to validate raw YAML-parsed input.
 */

import { z } from "zod";

// --- Name constraint: letters, digits, hyphens; starts with letter ---
const namePattern = /^[a-z][a-z0-9-]*$/;
const NameSchema = z.string().max(63).regex(namePattern, "Names must match ^[a-z][a-z0-9-]*$");

// --- Scalar enums ---

const RuntimeSchema = z.enum([
	"node", "bun", "deno", "python", "ruby", "go",
	"rust", "java", "php", "elixir", "csharp", "static",
]);

const ProtocolSchema = z.enum(["http", "https", "tcp", "udp", "grpc", "ws"]);

const GeneratorSchema = z.enum(["secret", "uuid", "port"]);

const RestartPolicySchema = z.enum(["always", "on-failure", "no"]);

const DependsOnConditionSchema = z.enum(["started", "healthy"]);

// --- Secrets ---

const SecretSchema = z.object({
	generator: GeneratorSchema,
	description: z.string().max(1024).optional(),
});

// --- Provides ---

/**
 * `tls: <name>` is shorthand for `tls: { certificate: <name> }` (D-61 rule
 * 1). Both spellings name one `supports:` entry of type `certificate` on the
 * same component; `checkCertificateBindings` below resolves the name, which
 * needs the whole component to answer.
 */
const TlsBindingSchema = z.union([
	NameSchema,
	// Strict, unlike the requirement objects around it: a binding-level `port:`
	// override is D-61 Left open (1), and strip mode would accept one and
	// silently drop it — the listener would then serve TLS on a port the author
	// believes they changed (P-14). The published JSON Schema rejects it too.
	z.strictObject({ certificate: NameSchema }),
]);

const ProvidesSchema = z.object({
	name: NameSchema.optional(),
	protocol: ProtocolSchema,
	port: z.number().int().min(1).max(65535),
	bind: z.string().optional(),
	exposed: z.boolean().optional(),
	spec: z.record(z.string(), z.string()).optional(),
	tls: TlsBindingSchema.optional(),
});

// --- Requirement (full form) ---

const RequirementObjectSchema = z.object({
	name: NameSchema.optional(),
	type: z.string().min(1).max(256),
	// A backing service never carries the `host:` marker. Without this the
	// union's strip mode would silently swallow `host:` on a `type:` entry,
	// erasing a declared privilege from the audit surface (D-44).
	host: z.never().optional(),
	// The `provides` entry this resource fronts, by its `name` (D-6).
	// Required on a `type: https-origin` entry and meaningless on any other
	// type — both enforced by `checkHttpsOrigin` below, which needs the whole
	// file to answer them.
	endpoint: NameSchema.optional(),
	version: z.string().max(256).optional(),
	// Security: config is intentionally unconstrained — providers MUST validate/sanitize
	// these values before using them in shell commands, SQL, or other injectable contexts.
	config: z.record(z.string(), z.unknown()).optional(),
	set_env: z.record(z.string(), z.string()).optional(),
});

// --- Host capability entry (D-44) ---

/**
 * A `host:`-marked capability entry in requires/supports. The marker
 * distinguishes a capability (granted or refused) from a backing service
 * (`type:` entry, provisioned). Values are an open vocabulary (L-4):
 * interface names like `docker`/`any`, or booleans (`privileged: true`).
 */
const HostCapabilityObjectSchema = z.object({
	host: z.record(z.string(), z.union([z.string(), z.boolean()])),
	// A capability is granted or refused, never provisioned, so it carries no
	// backing-service `type:`. Mutually exclusive with the branch above: an
	// entry with both keys matches neither and is reported, not silently fixed.
	type: z.never().optional(),
	// `endpoint:` belongs to a backing service that fronts one of the app's own
	// listeners; a capability fronts nothing. Listed for the same reason `host:`
	// is listed above — strip mode would swallow it without a word.
	endpoint: z.never().optional(),
	set_env: z.record(z.string(), z.string()).optional(),
});

/** Accepts string shorthand ("postgres"), full object, or a host-capability entry */
const RequirementSchema = z
	.unknown()
	// Reported before the union, because a union failure would only say
	// "Invalid input" for the one shape most likely to be written by mistake.
	.superRefine((val, ctx) => {
		if (
			typeof val === "object" &&
			val !== null &&
			!Array.isArray(val) &&
			"host" in val &&
			"type" in val
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"an entry is either a backing service (`type:`) or a host capability " +
					"(`host:`), never both (D-44) — split it into two entries",
			});
		}
		// Same reason, for the same reader: the union would report an
		// `endpoint:` on a capability entry as a bare "Invalid input".
		if (
			typeof val === "object" &&
			val !== null &&
			!Array.isArray(val) &&
			"host" in val &&
			"endpoint" in val
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"`endpoint:` names the `provides` entry a `type: https-origin` resource " +
					"fronts (D-60 rule 2); a host capability fronts nothing — remove it",
			});
		}
	})
	.pipe(
		z.union([
			z.string().min(1),
			RequirementObjectSchema,
			HostCapabilityObjectSchema,
		]),
	);

// --- Support (same shape as Requirement) ---

const SupportSchema = RequirementSchema;

// --- EnvVar ---

const EnvVarObjectSchema = z.object({
	default: z.union([z.string(), z.number(), z.boolean()]).optional(),
	description: z.string().max(1024).optional(),
	label: z.string().max(256).optional(),
	required: z.boolean().optional(),
	generator: GeneratorSchema.optional(),
	sensitive: z.boolean().optional(),
	example: z.string().max(256).optional(),
});

/** Accepts string shorthand ("8080") or full object */
const EnvVarSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	EnvVarObjectSchema,
]);

// --- Build ---

const BuildObjectSchema = z.object({
	context: z.string().max(1024).optional(),
	dockerfile: z.string().max(1024).optional(),
	target: z.string().max(256).optional(),
	args: z.record(z.string(), z.string()).optional(),
	secrets: z.array(z.string()).optional(),
});

/** Accepts string shorthand (".") or full object */
const BuildSchema = z.union([z.string(), BuildObjectSchema]);

// --- Health ---

const HealthObjectSchema = z.object({
	path: z.string().max(1024).optional(),
	command: z.string().max(10240).optional(),
	interval: z.string().max(64).optional(),
	timeout: z.string().max(64).optional(),
	retries: z.number().int().min(1).optional(),
	start_period: z.string().max(64).optional(),
});

/** Accepts string shorthand ("/health") or full object */
const HealthSchema = z.union([z.string(), HealthObjectSchema]);

// --- Capture entry (reusable shape, introduced by D-23, renamed by D-34) ---

/**
 * Schema for a named capture entry — a regex pattern matched against a
 * command's stdout, with optional description and sensitivity flag.
 *
 * Originally introduced by D-23 as the value type for the top-level
 * `outputs:` block, and renamed from `OutputSchema` to `CaptureEntrySchema`
 * by D-34 when the capture block moved inside the expanded command form
 * (`commands.*.capture`). The shape is unchanged; only the name reflects
 * its new role.
 */
const CaptureEntrySchema = z.object({
	// Security: validate that patterns compile as RegExp to catch errors early,
	// and cap length to limit ReDoS attack surface.
	pattern: z.string().max(1024).refine((p) => {
		try { new RegExp(p); return true; } catch { return false; }
	}, "Invalid regex pattern"),
	description: z.string().max(1024).optional(),
	sensitive: z.boolean().optional(),
});

// --- Commands ---

const CommandDetailSchema = z.object({
	command: z.string().max(10240),
	timeout: z.string().max(64).optional(),
	/**
	 * Named captures extracted from the command's stdout via regex (D-34).
	 * Supersedes the top-level `outputs:` placement from D-23 — the
	 * mechanism is preserved, only the location changes (P-10).
	 */
	capture: z.record(z.string(), CaptureEntrySchema).optional(),
});

/** Accepts string shorthand ("node server.js") or object with timeout + capture */
const CommandValueSchema = z.union([z.string().max(10240), CommandDetailSchema]);

const CommandsSchema = z.record(z.string(), CommandValueSchema);

// --- Storage ---

const StorageVolumeSchema = z.object({
	path: z.string().max(1024),
	// D-30 size hint. Every field the published JSON Schema declares must be
	// listed here too: zod strips unlisted keys, so an omission silently
	// deletes a documented field through parse → serialize.
	size: z.string().max(256).optional(),
	persistent: z.boolean().optional(),
	// D-50 provenance marker: the operator supplies this volume's content —
	// the provider binds it at `path` or refuses the component, and never
	// initializes it empty.
	content: z.enum(["operator"]).optional(),
});

// --- DependsOn ---

const DependsOnEntryObjectSchema = z.object({
	component: z.string().min(1),
	condition: DependsOnConditionSchema.optional(),
});

/** Accepts string shorthand ("backend") or object with condition */
const DependsOnEntrySchema = z.union([
	z.string().min(1),
	DependsOnEntryObjectSchema,
]);

// --- Host ---

const HostSchema = z.object({
	docker: z.enum(["required", "optional"]).optional(),
	network: z.enum(["host", "bridge"]).optional(),
	filesystem: z.enum(["read-write", "read-only", "none"]).optional(),
	privileged: z.boolean().optional(),
});

// --- Platform (string or array of strings) ---

const PlatformSchema = z.union([z.string(), z.array(z.string())]);

// --- Component ---

const ComponentSchema = z.object({
	runtime: RuntimeSchema.optional(),
	image: z.string().max(1024).optional(),
	build: BuildSchema.optional(),
	source: z.string().max(1024).optional(),
	provides: z.array(ProvidesSchema).optional(),
	requires: z.array(RequirementSchema).optional(),
	supports: z.array(SupportSchema).optional(),
	env: z.record(z.string(), EnvVarSchema).optional(),
	commands: CommandsSchema.optional(),
	health: HealthSchema.optional(),
	depends_on: z.array(DependsOnEntrySchema).optional(),
	storage: z.record(z.string(), StorageVolumeSchema).optional(),
	restart: RestartPolicySchema.optional(),
	schedule: z.string().optional(),
	singleton: z.boolean().optional(),
	platform: PlatformSchema.optional(),
	host: HostSchema.optional(),
});

// --- `https-origin` structural rules (D-60 rules 2 and 3) ---

/** The one backing-service type that fronts the app instead of backing it. */
const HTTPS_ORIGIN = "https-origin";

/**
 * Listener protocols an https origin can front (D-60 rule 2). All four are
 * addressed by a web origin (RFC 6454) and each already has a defined secure
 * scheme; `tcp` and `udp` have no origin at all.
 */
const HTTP_FAMILY_PROTOCOLS = new Set(["http", "https", "ws", "grpc"]);

interface EntryLike {
	type?: unknown;
	endpoint?: unknown;
	host?: unknown;
}

interface ProvidesLike {
	name?: unknown;
	protocol?: unknown;
	exposed?: unknown;
}

/** One `requires`/`supports` home: the top level, or a named component. */
interface OriginScope {
	/** How the scope is named in an error message. */
	label: string;
	/** Issue path prefix — `[]` at the top level, `["components", name]` otherwise. */
	prefix: Array<string | number>;
	requires?: unknown;
	supports?: unknown;
	provides?: unknown;
}

/**
 * Enforce the two cross-field rules an `https-origin` entry carries, neither of
 * which a per-entry schema can see: rule 2 (the endpoint reference resolves, on
 * the component that owns it, to one exposed HTTP-family listener) and rule 3
 * (at most one such entry across the whole app).
 *
 * Scoped deliberately to the component's OWN `provides`. Rule 2 requires the
 * entry to sit on the component that owns the endpoint, and a component that
 * declares no listener of its own owns none — resolving against an inherited
 * top-level list would reintroduce the one-entry-several-`provides`-lists
 * ambiguity the rule exists to forbid.
 */
function checkHttpsOrigin(
	launch: Record<string, unknown>,
	ctx: z.RefinementCtx,
): void {
	const components = launch.components as
		| Record<string, Record<string, unknown>>
		| undefined;
	const hasComponents =
		components !== undefined && Object.keys(components).length > 0;

	const scopes: OriginScope[] = [
		{
			label: "(top-level)",
			prefix: [],
			requires: launch.requires,
			supports: launch.supports,
			provides: launch.provides,
		},
	];
	if (hasComponents) {
		for (const [name, component] of Object.entries(components)) {
			if (typeof component !== "object" || component === null) continue;
			scopes.push({
				label: name,
				prefix: ["components", name],
				requires: component.requires,
				supports: component.supports,
				provides: component.provides,
			});
		}
	}

	let originEntries = 0;

	for (const scope of scopes) {
		for (const field of ["requires", "supports"] as const) {
			const list = scope[field];
			if (!Array.isArray(list)) continue;
			for (const [index, raw] of list.entries()) {
				if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
					continue;
				}
				const entry = raw as EntryLike;
				const path = [...scope.prefix, field, index];
				const isOrigin = entry.type === HTTPS_ORIGIN;

				if (!isOrigin) {
					if (entry.endpoint !== undefined && entry.host === undefined) {
						ctx.addIssue({
							code: "custom",
							path: [...path, "endpoint"],
							message:
								"`endpoint:` is only meaningful on a `type: " +
								`${HTTPS_ORIGIN}\` entry — this one declares \`type: ${String(entry.type)}\`` +
								" (D-60 rule 2). Remove it, or change the type.",
						});
					}
					continue;
				}

				originEntries++;

				if (hasComponents && scope.prefix.length === 0) {
					ctx.addIssue({
						code: "custom",
						path,
						message:
							`a \`${HTTPS_ORIGIN}\` entry must sit on the component that owns the endpoint, ` +
							"never at the top level of a file that declares `components:` — top-level " +
							"`requires` defaults into every component that declares none, so one entry " +
							"would face several `provides` lists (D-60 rule 2). Move it onto that component.",
					});
					continue;
				}

				if (typeof entry.endpoint !== "string") {
					ctx.addIssue({
						code: "custom",
						path: [...path, "endpoint"],
						message:
							`a \`${HTTPS_ORIGIN}\` entry must name the \`provides\` entry it fronts ` +
							"with `endpoint:` (D-60 rule 2)",
					});
					continue;
				}

				const provides = Array.isArray(scope.provides)
					? (scope.provides as ProvidesLike[])
					: [];
				const matches = provides.filter(
					(p) =>
						typeof p === "object" && p !== null && p.name === entry.endpoint,
				);

				if (matches.length === 0) {
					const named = provides
						.map((p) => p?.name)
						.filter((n): n is string => typeof n === "string");
					ctx.addIssue({
						code: "custom",
						path: [...path, "endpoint"],
						message:
							`${HTTPS_ORIGIN} endpoint "${entry.endpoint}" matches no \`provides\` entry on ` +
							`${scope.label} (D-60 rule 2). ` +
							(named.length > 0
								? `Named endpoints there: ${named.join(", ")}.`
								: "That component declares no named endpoint — add a `name:` to the one this origin fronts."),
					});
					continue;
				}
				if (matches.length > 1) {
					ctx.addIssue({
						code: "custom",
						path: [...path, "endpoint"],
						message:
							`${HTTPS_ORIGIN} endpoint "${entry.endpoint}" matches ${matches.length} \`provides\` ` +
							`entries on ${scope.label}; it must match exactly one (D-60 rule 2)`,
					});
					continue;
				}

				const [target] = matches as [ProvidesLike];
				if (target.exposed !== true) {
					ctx.addIssue({
						code: "custom",
						path: [...path, "endpoint"],
						message:
							`${HTTPS_ORIGIN} endpoint "${entry.endpoint}" is not \`exposed: true\`; an origin ` +
							"is a public address, and an unpublished endpoint has none (D-60 rule 2)",
					});
					continue;
				}
				const protocol =
					typeof target.protocol === "string" ? target.protocol : "";
				if (!HTTP_FAMILY_PROTOCOLS.has(protocol)) {
					ctx.addIssue({
						code: "custom",
						path: [...path, "endpoint"],
						message:
							`${HTTPS_ORIGIN} endpoint "${entry.endpoint}" declares \`protocol: ${protocol}\`; ` +
							"an https-origin fronts an HTTP-family listener (`http`, `https`, `ws`, `grpc`) — " +
							"a `tcp` or `udp` listener has no origin (D-60 rule 2). " +
							"Name the app's web endpoint instead.",
					});
				}
			}
		}
	}

	if (originEntries > 1) {
		ctx.addIssue({
			code: "custom",
			path: [],
			message:
				`an app declares at most one \`${HTTPS_ORIGIN}\` entry, and this one declares ` +
				`${originEntries} (D-60 rule 3) — the named endpoint is the app's primary, and ` +
				"only one endpoint can be that",
		});
	}
}

/**
 * D-next rule 4: a `provides[].name` is addressable app-wide through
 * `$app.endpoints.<name>.*`, by name alone, so the same name on two
 * components would give one expression two answers. Refused naming both.
 * Scoped to declaration sites — the top level and each component — the same
 * scopes `checkHttpsOrigin` reads; a name repeated within one component is
 * outside this rule (D-60 rule 2 already reports it where an `https-origin`
 * names it).
 */
function checkEndpointNames(
	launch: Record<string, unknown>,
	ctx: z.RefinementCtx,
): void {
	const components = launch.components as
		| Record<string, Record<string, unknown>>
		| undefined;
	const scopes: Array<{
		label: string;
		prefix: Array<string | number>;
		provides: unknown;
	}> = [{ label: "(top-level)", prefix: [], provides: launch.provides }];
	for (const [name, component] of Object.entries(components ?? {})) {
		if (typeof component !== "object" || component === null) continue;
		scopes.push({
			label: name,
			prefix: ["components", name],
			provides: component.provides,
		});
	}

	const seen = new Map<string, string>();
	for (const scope of scopes) {
		if (!Array.isArray(scope.provides)) continue;
		const local = new Set<string>();
		for (const [index, raw] of (scope.provides as ProvidesLike[]).entries()) {
			if (typeof raw !== "object" || raw === null) continue;
			const name = raw.name;
			if (typeof name !== "string" || local.has(name)) continue;
			local.add(name);
			const owner = seen.get(name);
			if (owner === undefined) {
				seen.set(name, scope.label);
				continue;
			}
			ctx.addIssue({
				code: "custom",
				path: [...scope.prefix, "provides", index, "name"],
				message:
					`\`provides\` entry "${name}" is named on both ${owner} and ${scope.label}; ` +
					"an endpoint name is app-wide — `$app.endpoints." +
					`${name}.*\` addresses it by name alone (D-next rule 4). Rename one.`,
			});
		}
	}
}

/** The `supports:` resource type a `tls:` binding names (D-61 rule 1). */
const CERTIFICATE = "certificate";

/** A `provides` entry, as far as the certificate rules need to see it. */
interface TlsProvidesLike {
	name?: unknown;
	protocol?: unknown;
	tls?: unknown;
}

/** The certificate name a `provides` entry binds, in either spelling. */
function tlsCertificateName(entry: TlsProvidesLike): string | undefined {
	const tls = entry.tls;
	if (typeof tls === "string") return tls;
	if (typeof tls === "object" && tls !== null && !Array.isArray(tls)) {
		const certificate = (tls as { certificate?: unknown }).certificate;
		if (typeof certificate === "string") return certificate;
	}
	return undefined;
}

/** How a `provides` entry is named in a message: its `name`, else its index. */
function providesLabel(entry: TlsProvidesLike, index: number): string {
	return typeof entry.name === "string"
		? `"${entry.name}"`
		: `#${index + 1} (unnamed)`;
}

/**
 * Enforce the structural rules a `tls:` binding carries (D-61 rule 1), none
 * of which a per-entry schema can see: the bound entry speaks an HTTP-family
 * protocol, the named certificate exists in the same component's `supports:`,
 * it declares `type: certificate`, no certificate is named by two entries, and
 * a binding naming a `requires:` entry is rejected as out of scope.
 *
 * Scoped to the component that declares the listener, for the same reason
 * {@link checkHttpsOrigin} is: the certificate is wired into that component's
 * environment, and resolving against another component's `supports:` would
 * bind a listener to material it never receives.
 */
function checkCertificateBindings(
	launch: Record<string, unknown>,
	ctx: z.RefinementCtx,
): void {
	const components = launch.components as
		| Record<string, Record<string, unknown>>
		| undefined;

	const scopes: OriginScope[] = [
		{
			label: "(top-level)",
			prefix: [],
			requires: launch.requires,
			supports: launch.supports,
			provides: launch.provides,
		},
	];
	if (components !== undefined) {
		for (const [name, component] of Object.entries(components)) {
			if (typeof component !== "object" || component === null) continue;
			scopes.push({
				label: name,
				prefix: ["components", name],
				requires: component.requires,
				supports: component.supports,
				provides: component.provides,
			});
		}
	}

	for (const scope of scopes) {
		const provides = Array.isArray(scope.provides)
			? (scope.provides as TlsProvidesLike[])
			: [];
		const supports = Array.isArray(scope.supports) ? scope.supports : [];
		const requires = Array.isArray(scope.requires) ? scope.requires : [];

		/** Entry index in this scope's `supports:`, keyed by `name ?? type`. */
		const namedEntry = (list: unknown[], name: string): EntryLike | undefined =>
			list.find((raw) => {
				if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
					return false;
				}
				const entry = raw as { name?: unknown; type?: unknown };
				const key = typeof entry.name === "string" ? entry.name : entry.type;
				return key === name;
			}) as EntryLike | undefined;

		/** First `provides` index that bound each certificate, for rule 1's twin check. */
		const claimed = new Map<string, number>();

		for (const [index, entry] of provides.entries()) {
			if (typeof entry !== "object" || entry === null) continue;
			const certificate = tlsCertificateName(entry);
			if (certificate === undefined) continue;
			const path = [...scope.prefix, "provides", index, "tls"];

			const protocol =
				typeof entry.protocol === "string" ? entry.protocol : "";
			if (!HTTP_FAMILY_PROTOCOLS.has(protocol)) {
				ctx.addIssue({
					code: "custom",
					path,
					message:
						`\`tls: ${certificate}\` binds \`provides\` entry ` +
						`${providesLabel(entry, index)} on ${scope.label}, which declares ` +
						`\`protocol: ${protocol}\`; an active binding makes a listener's ` +
						"effective protocol `https`, which only an HTTP-family listener " +
						"(`http`, `https`, `ws`, `grpc`) can speak — a `tcp` or `udp` " +
						"listener cannot (D-61 rule 1, on D-60 rule 2's family line). " +
						"TLS on a non-HTTP listener is D-61 Left open (6).",
				});
				continue;
			}

			const first = claimed.get(certificate);
			if (first !== undefined) {
				ctx.addIssue({
					code: "custom",
					path,
					message:
						`certificate "${certificate}" is bound by two \`provides\` entries on ` +
						`${scope.label} — ${providesLabel(provides[first]!, first)} and ` +
						`${providesLabel(entry, index)}. A certificate binds exactly one listener ` +
						"(D-61 rule 1); declare a second `certificate` entry for the other.",
				});
				continue;
			}
			claimed.set(certificate, index);

			const supported = namedEntry(supports, certificate);
			if (!supported) {
				const required = namedEntry(requires, certificate);
				if (required) {
					ctx.addIssue({
						code: "custom",
						path,
						message:
							`\`tls: ${certificate}\` names a \`requires:\` entry on ${scope.label}. ` +
							"Required native TLS is out of scope for D-61, which binds the optional " +
							"mood only — move the entry to `supports:`, or track the requirement on " +
							"D-61 Left open (2) (github.com/launchfile/launchfile/issues/314, " +
							"dimension A's `requires:` half).",
					});
					continue;
				}
				const available = supports
					.map((raw) =>
						typeof raw === "object" && raw !== null && !Array.isArray(raw)
							? ((raw as { name?: unknown; type?: unknown }).name ??
								(raw as { type?: unknown }).type)
							: raw,
					)
					.filter((n): n is string => typeof n === "string");
				ctx.addIssue({
					code: "custom",
					path,
					message:
						`\`tls: ${certificate}\` names no \`supports:\` entry on ${scope.label} ` +
						"(D-61 rule 1). " +
						(available.length > 0
							? `Entries there: ${available.join(", ")}.`
							: "That component declares no `supports:` entry — add one of `type: certificate`."),
				});
				continue;
			}

			if (supported.type !== CERTIFICATE) {
				ctx.addIssue({
					code: "custom",
					path,
					message:
						`\`tls: ${certificate}\` names a \`supports:\` entry of \`type: ` +
						`${String(supported.type)}\` on ${scope.label}; a \`tls:\` binding names ` +
						`an entry of \`type: ${CERTIFICATE}\` (D-61 rule 1)`,
				});
			}
		}
	}
}

// --- Top-Level Launch ---

export const LaunchSchema = z.object({
	version: z.string().max(64).optional(),
	generator: z.string().max(256).optional(),
	name: NameSchema,
	description: z.string().max(4096).optional(),

	// Metadata
	repository: z.string().max(1024).optional(),
	website: z.string().max(1024).optional(),
	logo: z.string().max(1024).optional(),
	keywords: z.array(z.string().max(128)).max(64).optional(),

	// App-wide secrets
	secrets: z.record(z.string(), SecretSchema).optional(),

	// Single-component shorthand fields
	runtime: RuntimeSchema.optional(),
	image: z.string().max(1024).optional(),
	build: BuildSchema.optional(),
	source: z.string().max(1024).optional(),
	provides: z.array(ProvidesSchema).optional(),
	requires: z.array(RequirementSchema).optional(),
	supports: z.array(SupportSchema).optional(),
	env: z.record(z.string(), EnvVarSchema).optional(),
	commands: CommandsSchema.optional(),
	health: HealthSchema.optional(),
	depends_on: z.array(DependsOnEntrySchema).optional(),
	storage: z.record(z.string(), StorageVolumeSchema).optional(),
	restart: RestartPolicySchema.optional(),
	schedule: z.string().optional(),
	singleton: z.boolean().optional(),
	platform: PlatformSchema.optional(),
	host: HostSchema.optional(),

	// Multi-component
	components: z.record(z.string(), ComponentSchema).optional(),
}).superRefine((launch, ctx) => {
	checkHttpsOrigin(launch as Record<string, unknown>, ctx);
	checkEndpointNames(launch as Record<string, unknown>, ctx);
	checkCertificateBindings(launch as Record<string, unknown>, ctx);
});

// --- Exported sub-schemas for testing ---

export {
	NameSchema,
	RuntimeSchema,
	SecretSchema,
	ProtocolSchema,
	GeneratorSchema,
	RestartPolicySchema,
	ProvidesSchema,
	TlsBindingSchema,
	RequirementObjectSchema,
	RequirementSchema,
	HostCapabilityObjectSchema,
	SupportSchema,
	EnvVarObjectSchema,
	EnvVarSchema,
	BuildObjectSchema,
	BuildSchema,
	HealthObjectSchema,
	HealthSchema,
	CommandDetailSchema,
	CommandValueSchema,
	CommandsSchema,
	CaptureEntrySchema,
	HostSchema,
	PlatformSchema,
	StorageVolumeSchema,
	DependsOnEntrySchema,
	DependsOnEntryObjectSchema,
	ComponentSchema,
};
