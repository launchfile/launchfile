/**
 * Launchfile → Terraform (HCL) translator — the AWS conformance probe.
 *
 * Maps the *portable contract* (`runtime` + `commands`) onto AWS primitives:
 * EC2 builds from source via cloud-init (no Dockerfile — RFC C / #78), RDS and
 * ElastiCache stand in for `requires`, an ALB fronts `exposed` provides, EBS
 * backs `storage`, and SSM holds resolved `env`. It is **artifact-only and
 * translation-only**: it emits `.tf` and never runs `apply`.
 *
 * Every field is accounted for on the `Conformance` ledger — mapped, gapped, or
 * (for OCI specializations the contract already covers) safely ignored. That
 * ledger is the deliverable; the HCL is just the evidence it's real.
 */

import {
	deriveAppUrlProperties,
	isExpression,
	type NormalizedComponent,
	type NormalizedEnvVar,
	type NormalizedLaunch,
	type NormalizedRequirement,
	type ResolverContext,
	type RestartPolicy,
	resolveExpression,
	unsuppliedRequiredEnv,
	appEndpointReferences,
	type AppEndpointProperties,
	UNPUBLISHED_APP_ENDPOINT,
} from "@launchfile/sdk";
import { Conformance } from "./gaps.js";
import {
	attr,
	block,
	document,
	type HclValue,
	heredoc,
	interp,
	raw,
	ref,
	tfName,
} from "./hcl.js";
import type { GeneratorResource, PriorStack } from "./prior-stack.js";

/** The backing-service type that declares the app's public HTTPS origin (D-60). */
const HTTPS_ORIGIN = "https-origin";

/**
 * Launchfile `restart:` → the systemd `Restart=` directive on the generated unit.
 *
 * The two enums are separate vocabularies that happen to share spellings today,
 * so the mapping is explicit: a value added to Launchfile's `restart:` fails to
 * compile here rather than reaching a systemd directive unreviewed (P-13).
 * All three are meaningful because the unit sets no `Type=`, so systemd applies
 * `Type=simple`.
 */
const RESTART_DIRECTIVE: Record<RestartPolicy, string> = {
	always: "always",
	"on-failure": "on-failure",
	no: "no",
};

/**
 * The directive used when a component declares no `restart:`. A long-running
 * service the file says nothing about stays supervised; the cross-provider
 * default for an undeclared `restart:` is decided in #234, not here.
 */
const DEFAULT_RESTART_DIRECTIVE = "always";

/** The `supports:` type a `provides` entry's `tls:` binds (D-61). */
const CERTIFICATE = "certificate";

export interface TranslateOptions {
	/** AWS region for the provider block. Default: us-east-1. */
	region?: string;
	/**
	 * What an earlier translation or apply already minted, read from the output
	 * directory by `readPriorStack()`. Absent means a fresh stack: every
	 * generator is minted for the first time and D-47 governs the output.
	 */
	priorStack?: PriorStack;
}

export interface TranslateResult {
	/** The generated Terraform document. */
	hcl: string;
	/** The conformance ledger: what mapped, gapped, and was ignored. */
	conformance: Conformance;
	/**
	 * Terraform addresses of secrets kept in their pre-D-47 shape because
	 * re-minting them would destroy the deployed value (D-49).
	 */
	preservedSecrets: string[];
}

/** Where a `generator:` was declared — named in a refusal so the operator can find it. */
export interface GeneratorSite {
	/** The app the Launchfile names. */
	app: string;
	/** The owning component, or absent for an app-wide `secrets:` entry. */
	component?: string;
	/** The secret name or env key. */
	variable: string;
}

/**
 * A minted value already exists under a Terraform resource type this
 * translation would not emit, and no `moved` block bridges a type change — so
 * applying would destroy the value. The provider refuses instead (D-49,
 * PROVIDERS.md §10 rule 8's never-fabricate posture applied to a destructive
 * change). Carries the coordinates rather than only a rendered string so a
 * caller can present them its own way.
 */
export class SecretRotationError extends Error {
	readonly site: GeneratorSite;
	readonly address: string;
	readonly had: GeneratorResource;
	readonly wants: GeneratorResource;

	constructor(
		site: GeneratorSite,
		tf: string,
		had: GeneratorResource,
		wants: GeneratorResource,
	) {
		const scope = site.component
			? `component ${site.component}`
			: "app-wide `secrets:` entry";
		super(
			[
				`Refusing to translate ${site.app}: this would destroy a secret that already exists.`,
				"",
				`  app:       ${site.app}`,
				`  scope:     ${scope}`,
				`  variable:  ${site.variable}`,
				`  minted as: ${had}.${tf}`,
				`  would be:  ${wants}.${tf}`,
				"",
				"Terraform cannot migrate state across a resource-type change — a `moved`",
				"block only bridges renames of the same type — so the next `terraform apply`",
				"would destroy the old value and create a new one. Anything encrypted under",
				"the old value becomes unreadable. A minted value is generated once and then",
				"preserved (spec/DESIGN.md D-49). Nothing was written.",
				"",
				"To re-key deliberately, after backing up anything encrypted under it:",
				`  1. terraform state rm '${had}.${tf}'`,
				"  2. re-run `launchfile-aws translate`, then `terraform apply`",
				"  3. re-key the app with the new value",
			].join("\n"),
		);
		this.name = "SecretRotationError";
		this.site = site;
		this.address = `${had}.${tf}`;
		this.had = had;
		this.wants = wants;
	}
}

// --- AWS sizing defaults (a probe never applies, so these are illustrative) ---
const INSTANCE_TYPE = "t3.small";
const DB_INSTANCE_CLASS = "db.t3.micro";
const CACHE_NODE_TYPE = "cache.t3.micro";
const VPC_CIDR = "10.0.0.0/16";

/** Backing services this probe can stand up as managed AWS resources. */
const MANAGED_RESOURCES: Record<
	string,
	{ engine: string; port: number; kind: "rds" | "elasticache" }
> = {
	postgres: { engine: "postgres", port: 5432, kind: "rds" },
	mysql: { engine: "mysql", port: 3306, kind: "rds" },
	mariadb: { engine: "mariadb", port: 3306, kind: "rds" },
	redis: { engine: "redis", port: 6379, kind: "elasticache" },
};

/**
 * The property keys each managed resource type exposes, keyed by type.
 *
 * Derived by running the emitters against a throwaway block list, not
 * hand-listed: the conformance test (`__tests__/resource-conformance.test.ts`)
 * compares these against `spec/schema/resource-properties.json`, and a
 * hand-maintained copy would drift from the emitters, which is the drift the
 * check exists to catch.
 */
export function resourcePropertyKeys(): Record<string, string[]> {
	const keys: Record<string, string[]> = {};
	for (const [type, spec] of Object.entries(MANAGED_RESOURCES)) {
		const discarded: string[] = [];
		const properties =
			spec.kind === "rds"
				? emitRds(
						discarded,
						"probe",
						type,
						{ type } as NormalizedRequirement,
						spec.engine,
						spec.port,
					)
				: emitElastiCache(discarded, "probe", type);
		keys[type] = Object.keys(properties);
	}
	return keys;
}

/** Lowercase, DNS-safe identifier for AWS resource names (RDS identifiers, cache cluster ids). */
function dnsName(name: string): string {
	// Linear-time trim (no anchored `-+` ReDoS on untrusted names) — same shape as tfName.
	const collapsed = name
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-{2,}/g, "-");
	const start = collapsed.startsWith("-") ? 1 : 0;
	const end = collapsed.endsWith("-") ? collapsed.length - 1 : collapsed.length;
	const cleaned = collapsed.slice(start, Math.max(start, end));
	const safe = cleaned.length > 0 ? cleaned : "app";
	return /^[0-9]/.test(safe) ? `a${safe}` : safe;
}

/** Alphanumeric DB name (RDS db_name must start with a letter, no hyphens). */
function dbName(name: string): string {
	const cleaned = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	const safe = cleaned.length > 0 ? cleaned : "app";
	return /^[0-9]/.test(safe) ? `a${safe}` : safe;
}

/** Turn a resolved env value into an HCL value, preserving Terraform interpolations. */
function toHcl(value: string): HclValue {
	return value.includes("${") ? interp(value) : value;
}

/** Map a Launchfile runtime to a representative cloud-init install line. */
function runtimeInstall(runtime: string | undefined): string {
	switch (runtime) {
		case "node":
			return "curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && dnf install -y nodejs";
		case "bun":
			return "curl -fsSL https://bun.sh/install | bash";
		case "python":
			return "dnf install -y python3 python3-pip";
		case "ruby":
			return "dnf install -y ruby ruby-devel";
		case "go":
			return "dnf install -y golang";
		case "rust":
			return "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y";
		case "java":
			return "dnf install -y java-21-amazon-corretto";
		case "php":
			return "dnf install -y php php-cli";
		case "elixir":
			return "dnf install -y elixir";
		default:
			return `# no install recipe for runtime '${runtime ?? "(none)"}' — relying on AMI defaults`;
	}
}

/** Build the cloud-init user_data that fills the prepare → release → run slots on EC2. */
function cloudInit(
	component: NormalizedComponent,
	serviceName: string,
): string {
	const lines: string[] = [
		"#!/bin/bash",
		"set -euxo pipefail",
		"",
		runtimeInstall(component.runtime),
		"",
	];
	lines.push("mkdir -p /opt/app && cd /opt/app");
	lines.push(
		"# Source is expected to be present at /opt/app (clone/copy handled out of band for this probe).",
	);
	lines.push("");
	if (component.commands?.build) {
		lines.push("# prepare slot (artifact mode): commands.build");
		lines.push(component.commands.build.command);
		lines.push("");
	}
	if (component.commands?.release) {
		lines.push("# release slot: commands.release");
		lines.push(component.commands.release.command);
		lines.push("");
	}
	const start = component.commands?.start?.command ?? "echo 'no start command'";
	lines.push("# run slot (artifact mode): commands.start → systemd unit");
	lines.push(`cat >/etc/systemd/system/${serviceName}.service <<'UNIT'`);
	lines.push("[Unit]");
	lines.push("Description=Launchfile app: " + serviceName);
	lines.push("After=network.target");
	lines.push("");
	lines.push("[Service]");
	lines.push("WorkingDirectory=/opt/app");
	lines.push("EnvironmentFile=-/etc/launchfile/" + serviceName + ".env");
	lines.push(`ExecStart=/bin/bash -lc ${JSON.stringify(start)}`);
	lines.push(
		`Restart=${component.restart ? RESTART_DIRECTIVE[component.restart] : DEFAULT_RESTART_DIRECTIVE}`,
	);
	lines.push("");
	lines.push("[Install]");
	lines.push("WantedBy=multi-user.target");
	lines.push("UNIT");
	lines.push(
		`systemctl daemon-reload && systemctl enable --now ${serviceName}.service`,
	);
	return lines.join("\n");
}

export function translate(
	launch: NormalizedLaunch,
	opts: TranslateOptions = {},
): TranslateResult {
	const c = new Conformance();
	const blocks: string[] = [];
	const region = opts.region ?? "us-east-1";
	const appTf = tfName(launch.name);
	const preservedSecrets: string[] = [];
	const mint: MintContext = {
		app: launch.name,
		c,
		prior: opts.priorStack,
		preserved: preservedSecrets,
	};

	// --- Determine the exposed/primary component for $app.* and the ALB ---
	const exposedComponents: string[] = [];
	for (const [name, comp] of Object.entries(launch.components)) {
		if ((comp.provides ?? []).some((p) => p.exposed === true))
			exposedComponents.push(name);
	}
	const hasAlb = exposedComponents.length > 0;

	// --- App-wide $app.* properties (D-33/D-35), computed from the routing strategy ---
	let appProps: Record<string, string | number>;
	if (hasAlb) {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal Terraform interpolation, not a JS template
		const albDns = "${aws_lb.main.dns_name}";
		const url = `http://${albDns}`;
		appProps = {
			name: launch.name,
			host: albDns,
			port: 80,
			url,
			// Derive split-field tokens from a clean placeholder so authority/scheme/tls
			// are sensible; the host is the live ALB interpolation.
			...deriveAppUrlProperties("http://APP_HOST"),
			authority: albDns,
		};
	} else {
		appProps = {
			name: launch.name,
			host: "",
			port: 0,
			url: "",
			...deriveAppUrlProperties(""),
		};
	}

	// --- App-wide secrets (D-18) → random_* resources ---
	const secretValues: Record<string, string> = {};
	if (launch.secrets) {
		for (const [name, secret] of Object.entries(launch.secrets)) {
			const tf = `lf_secret_${tfName(name)}`;
			const emitted = emitGenerator(
				blocks,
				tf,
				secret.generator,
				{ app: launch.name, variable: name },
				mint,
			);
			secretValues[name] = emitted.value;
			c.map(`secrets.${name}`, emitted.resource);
		}
	}

	// --- `$app.endpoints.<name>.*` (D-63 rule 4): "" for every property ---
	// The ALB above fronts one target group and yields one address, so this
	// probe publishes no per-endpoint address — the primary's included: its
	// `$app.endpoints` entry is "" rather than a copy of `$app.*`, since the
	// per-endpoint form promises a per-endpoint publication (#487). Reported on
	// the conformance record for every endpoint the file references, so the
	// empty value is never a silent one.
	const appEndpoints: Record<string, AppEndpointProperties> = {};
	for (const comp of Object.values(launch.components)) {
		for (const p of comp.provides ?? []) {
			if (p.name !== undefined && p.exposed === true) {
				appEndpoints[p.name] ??= UNPUBLISHED_APP_ENDPOINT;
			}
		}
	}
	const referencedEndpoints = new Map<string, string>();
	for (const ref of appEndpointReferences(launch)) {
		const name = ref.path[2] ?? "";
		if (!referencedEndpoints.has(name)) referencedEndpoints.set(name, ref.component);
	}
	for (const [name, component] of referencedEndpoints) {
		c.gap(
			`$app.endpoints.${name}`,
			"workaround",
			"this provider publishes no per-endpoint public address, so every " +
				`$app.endpoints.${name}.* property resolves "" (D-63 rule 4)`,
			"supply the value through the environment, or front the endpoint yourself",
			component,
		);
	}

	// --- Resolver context (provider supplies home-#3 values) ---
	const resourceMap: Record<string, Record<string, string | number>> = {};
	const componentMap: Record<string, Record<string, string | number>> = {};
	const baseContext: ResolverContext = {
		resources: resourceMap,
		components: componentMap,
		secrets: secretValues,
		app: appProps,
		appEndpoints,
	};

	// --- Register sibling component endpoints (private IP, container port) ---
	for (const [name, comp] of Object.entries(launch.components)) {
		const first = (comp.provides ?? [])[0];
		if (!first) continue;
		const compTf = tfName(name);
		const ip = `\${aws_instance.${appTf}_${compTf}.private_ip}`;
		componentMap[name] = {
			host: ip,
			port: first.port,
			url: `http://${ip}:${first.port}`,
		};
	}

	// --- Provision app-level backing services (requires) once, keyed by resource name ---
	const provisioned = new Set<string>();
	let needsDbSubnetGroup = false;
	let needsCacheSubnetGroup = false;
	for (const comp of Object.values(launch.components)) {
		for (const req of comp.requires ?? []) {
			// A host capability (D-44) is granted or refused, never provisioned.
			// Without this it is reported as a missing managed-service mapping,
			// which both loses the capability name and grades a privileged
			// request as a "workaround" rather than a blocker.
			if (req.host) continue;
			const resourceName = req.name ?? req.type;
			if (provisioned.has(resourceName)) continue;
			// `https-origin` (D-60) sits in FRONT of the app, so no managed
			// service maps it: this probe composes `$app.*` from the ALB's
			// `${aws_lb.main.dns_name}`, an http:// address that does not exist
			// until apply time and carries no certificate. Reported unmapped
			// rather than silently dropped (PROVIDERS.md §10 items 5 and 8);
			// wiring an ACM certificate and an HTTPS listener is separate work.
			if (req.type === HTTPS_ORIGIN) {
				c.gap(
					`requires:${HTTPS_ORIGIN}`,
					"blocker",
					`the app requires a public HTTPS origin in front of endpoint '${req.endpoint ?? "?"}', and this probe emits an http-only load balancer`,
					"terminate TLS at the ALB (aws_acm_certificate + an HTTPS listener) before deploying this app",
				);
				continue;
			}
			const spec = MANAGED_RESOURCES[req.type];
			if (!spec) {
				c.gap(
					`requires:${req.type}`,
					"workaround",
					`no managed AWS service mapping for resource type '${req.type}'`,
					"model as a self-hosted component, or extend MANAGED_RESOURCES",
				);
				continue;
			}
			provisioned.add(resourceName);
			if (spec.kind === "rds") {
				needsDbSubnetGroup = true;
				resourceMap[resourceName] = emitRds(
					blocks,
					appTf,
					resourceName,
					req,
					spec.engine,
					spec.port,
				);
				c.map(`requires:${req.type}`, "aws_db_instance");
			} else {
				needsCacheSubnetGroup = true;
				resourceMap[resourceName] = emitElastiCache(
					blocks,
					appTf,
					resourceName,
				);
				c.map(`requires:${req.type}`, "aws_elasticache_cluster");
			}
		}
		for (const sup of comp.supports ?? []) {
			if (sup.host) continue; // capability, not a backing service (D-44)
			// A `certificate` (D-61) is delivered material, not a managed
			// service: it activates the app's OWN listener. This probe emits no
			// way to place a certificate inside the task, and on `translate`
			// there is no launch at which to refuse — so the entry is reported
			// unmapped rather than silently dropped (PROVIDERS.md §10 items 5
			// and 8). Terminating TLS at the ALB is a different arrangement and
			// does not fulfil this entry (D-61 rule 4).
			if (sup.type === CERTIFICATE) {
				const bound = (comp.provides ?? []).find((p) => {
					const tls = p.tls;
					const name = typeof tls === "string" ? tls : tls?.certificate;
					return name === (sup.name ?? sup.type);
				});
				c.gap(
					`supports:${CERTIFICATE}`,
					"nice-to-have",
					`the app can serve TLS on its own listener${bound?.name ? ` '${bound.name}'` : ""} with the certificate '${sup.name ?? sup.type}', and this probe has no way to place one in the task`,
					"mount the certificate into the task and supply cert_file/key_file, or terminate TLS at the ALB instead — a different arrangement, not this entry",
				);
				continue;
			}
			if (sup.type === HTTPS_ORIGIN) {
				c.gap(
					`supports:${HTTPS_ORIGIN}`,
					"nice-to-have",
					`the app would use a public HTTPS origin in front of endpoint '${sup.endpoint ?? "?"}', and this probe emits an http-only load balancer`,
					"terminate TLS at the ALB (aws_acm_certificate + an HTTPS listener)",
				);
				continue;
			}
			c.gap(
				`supports:${sup.type}`,
				"nice-to-have",
				"optional resources (supports) are not provisioned by this probe",
				"provision behind a Terraform variable toggle",
			);
		}
	}

	// --- Foundation: provider, data sources, VPC/subnets/IGW/routes ---
	const foundation = emitFoundation(
		region,
		appTf,
		needsDbSubnetGroup,
		needsCacheSubnetGroup,
	);
	// Foundation must come first in the document; prepend.
	blocks.unshift(...foundation);

	// --- Per-component compute ---
	const targetGroupFor: Record<string, string> = {};
	for (const [name, comp] of Object.entries(launch.components)) {
		emitComponent(
			blocks,
			c,
			launch,
			name,
			comp,
			appTf,
			baseContext,
			targetGroupFor,
			mint,
		);
	}

	// --- ALB fronting exposed provides ---
	if (hasAlb) {
		emitAlb(blocks, c, appTf, launch, exposedComponents, targetGroupFor);
	}

	return { hcl: document(blocks), conformance: c, preservedSecrets };
}

// ---------------------------------------------------------------------------
// Emitters — each appends Terraform blocks and returns any properties needed
// for expression resolution.
// ---------------------------------------------------------------------------

/** The resource type this provider mints each generator as today. */
const GENERATOR_RESOURCE: Record<string, GeneratorResource> = {
	uuid: "random_uuid",
	port: "random_integer",
	secret: "random_bytes",
};

/**
 * Minted-class resources (D-49 class 1): generated once, then preserved.
 * `random_integer` is absent deliberately — D-49 exempts `generator: port`,
 * because a port is an allocation, not an identity.
 */
const MINTED_RESOURCES: readonly GeneratorResource[] = [
	"random_bytes",
	"random_password",
	"random_uuid",
];

interface GeneratorEmission {
	/** The Terraform interpolation that carries the value. */
	value: string;
	/** The resource type actually emitted. */
	resource: GeneratorResource;
	/** True when a pre-D-47 secret was kept rather than re-minted. */
	preserved: boolean;
}

/** Everything the generator emitters need beyond the block list. */
interface MintContext {
	app: string;
	c: Conformance;
	prior: PriorStack | undefined;
	preserved: string[];
}

/**
 * Emit a `generator:` value, preserving anything already minted.
 *
 * The value of a minted secret lives in Terraform state under a resource's type
 * *and* name, so changing the type destroys it. Three outcomes:
 *
 *   - nothing minted before, or the same type → emit today's shape (D-47).
 *   - a pre-D-47 `random_password` under a `generator: secret` → keep emitting
 *     `random_password`, unchanged, so the deployed value survives.
 *   - any other type change over a minted value → refuse (`SecretRotationError`).
 *
 * The preserved value itself is never read and never written into the HCL — the
 * resource stays and Terraform keeps its own state.
 */
function emitGenerator(
	blocks: string[],
	tf: string,
	generator: string,
	site: GeneratorSite,
	m: MintContext,
): GeneratorEmission {
	const wants = GENERATOR_RESOURCE[generator] ?? "random_bytes";
	const had = m.prior?.generators[tf];

	if (had !== undefined && had !== wants) {
		if (generator === "secret" && had === "random_password") {
			// Byte-for-byte the pre-D-47 block, so `terraform plan` shows no diff
			// for it. D-47's output governs secrets minted from here on.
			blocks.push(
				block(
					"resource",
					["random_password", tf],
					[attr("length", 32), attr("special", false)],
				),
			);
			m.preserved.push(`random_password.${tf}`);
			m.c.gap(
				site.component ? `env.${site.variable}` : `secrets.${site.variable}`,
				"workaround",
				"already minted before D-47, so the deployed value is 32 alphanumeric characters, not 64 hex — preserved as `random_password` because a minted value must survive (D-49) and Terraform cannot migrate state across a resource-type change",
				"re-key deliberately when the app can take it: back up anything encrypted under it, `terraform state rm` the resource, re-translate, apply, then re-key the app",
				site.component,
			);
			return {
				value: `\${random_password.${tf}.result}`,
				resource: "random_password",
				preserved: true,
			};
		}
		if (MINTED_RESOURCES.includes(had)) {
			throw new SecretRotationError(site, tf, had, wants);
		}
	}

	if (generator === "uuid") {
		blocks.push(block("resource", ["random_uuid", tf], []));
		return {
			value: `\${random_uuid.${tf}.result}`,
			resource: "random_uuid",
			preserved: false,
		};
	}
	if (generator === "port") {
		blocks.push(
			block(
				"resource",
				["random_integer", tf],
				[attr("min", 1024), attr("max", 65535)],
			),
		);
		return {
			value: `\${random_integer.${tf}.result}`,
			resource: "random_integer",
			preserved: false,
		};
	}
	// "secret" — spec-defined output: 32 bytes of cryptographically random
	// data, hex-encoded (64 characters). See spec/DESIGN.md D-47.
	// random_bytes (hashicorp/random >= 3.6) marks its outputs sensitive in
	// state and plan; random_id's .hex would be stored and shown in plain.
	blocks.push(block("resource", ["random_bytes", tf], [attr("length", 32)]));
	return {
		value: `\${random_bytes.${tf}.hex}`,
		resource: "random_bytes",
		preserved: false,
	};
}

function emitFoundation(
	region: string,
	appTf: string,
	dbSubnetGroup: boolean,
	cacheSubnetGroup: boolean,
): string[] {
	const out: string[] = [];

	out.push(
		block(
			"terraform",
			[],
			[
				block(
					"required_providers",
					[],
					[
						attr("aws", { source: "hashicorp/aws", version: "~> 5.0" }),
						attr("random", { source: "hashicorp/random", version: "~> 3.6" }),
					],
				),
			],
		),
	);
	out.push(block("provider", ["aws"], [attr("region", region)]));

	out.push(
		block(
			"data",
			["aws_availability_zones", "available"],
			[attr("state", "available")],
		),
	);
	out.push(
		block(
			"data",
			["aws_ami", "al2023"],
			[
				attr("most_recent", true),
				attr("owners", ["amazon"]),
				block(
					"filter",
					[],
					[attr("name", "name"), attr("values", ["al2023-ami-*-x86_64"])],
				),
			],
		),
	);

	out.push(
		block(
			"resource",
			["aws_vpc", "main"],
			[
				attr("cidr_block", VPC_CIDR),
				attr("enable_dns_hostnames", true),
				attr("enable_dns_support", true),
				attr("tags", { Name: `${appTf}-vpc` }),
			],
		),
	);
	out.push(
		block(
			"resource",
			["aws_internet_gateway", "main"],
			[attr("vpc_id", ref("aws_vpc", "main", "id"))],
		),
	);

	for (const [i, suffix] of ["a", "b"].entries()) {
		out.push(
			block(
				"resource",
				["aws_subnet", `public_${suffix}`],
				[
					attr("vpc_id", ref("aws_vpc", "main", "id")),
					attr("cidr_block", `10.0.${i}.0/24`),
					attr(
						"availability_zone",
						raw(`data.aws_availability_zones.available.names[${i}]`),
					),
					attr("map_public_ip_on_launch", true),
					attr("tags", { Name: `${appTf}-public-${suffix}` }),
				],
			),
		);
	}

	out.push(
		block(
			"resource",
			["aws_route_table", "public"],
			[
				attr("vpc_id", ref("aws_vpc", "main", "id")),
				block(
					"route",
					[],
					[
						attr("cidr_block", "0.0.0.0/0"),
						attr("gateway_id", ref("aws_internet_gateway", "main", "id")),
					],
				),
			],
		),
	);
	for (const suffix of ["a", "b"]) {
		out.push(
			block(
				"resource",
				["aws_route_table_association", suffix],
				[
					attr("subnet_id", ref("aws_subnet", `public_${suffix}`, "id")),
					attr("route_table_id", ref("aws_route_table", "public", "id")),
				],
			),
		);
	}

	if (dbSubnetGroup) {
		out.push(
			block(
				"resource",
				["aws_db_subnet_group", "main"],
				[
					attr("name", `${dnsName(appTf)}-db`),
					attr("subnet_ids", [
						ref("aws_subnet", "public_a", "id"),
						ref("aws_subnet", "public_b", "id"),
					]),
				],
			),
		);
		out.push(
			block(
				"resource",
				["aws_security_group", "rds"],
				[
					attr("name", `${dnsName(appTf)}-rds`),
					attr("vpc_id", ref("aws_vpc", "main", "id")),
					block(
						"ingress",
						[],
						[
							attr("from_port", 0),
							attr("to_port", 65535),
							attr("protocol", "tcp"),
							attr("cidr_blocks", [VPC_CIDR]),
						],
					),
					block(
						"egress",
						[],
						[
							attr("from_port", 0),
							attr("to_port", 0),
							attr("protocol", "-1"),
							attr("cidr_blocks", ["0.0.0.0/0"]),
						],
					),
				],
			),
		);
	}
	if (cacheSubnetGroup) {
		out.push(
			block(
				"resource",
				["aws_elasticache_subnet_group", "main"],
				[
					attr("name", `${dnsName(appTf)}-cache`),
					attr("subnet_ids", [
						ref("aws_subnet", "public_a", "id"),
						ref("aws_subnet", "public_b", "id"),
					]),
				],
			),
		);
		out.push(
			block(
				"resource",
				["aws_security_group", "cache"],
				[
					attr("name", `${dnsName(appTf)}-cache`),
					attr("vpc_id", ref("aws_vpc", "main", "id")),
					block(
						"ingress",
						[],
						[
							attr("from_port", 0),
							attr("to_port", 65535),
							attr("protocol", "tcp"),
							attr("cidr_blocks", [VPC_CIDR]),
						],
					),
					block(
						"egress",
						[],
						[
							attr("from_port", 0),
							attr("to_port", 0),
							attr("protocol", "-1"),
							attr("cidr_blocks", ["0.0.0.0/0"]),
						],
					),
				],
			),
		);
	}

	return out;
}

function emitRds(
	blocks: string[],
	appTf: string,
	resourceName: string,
	req: NormalizedRequirement,
	engine: string,
	port: number,
): Record<string, string | number> {
	const tf = `${appTf}_${tfName(resourceName)}`;
	const pwTf = `${tf}_pw`;
	const db = dbName(resourceName);
	blocks.push(
		block(
			"resource",
			["random_password", pwTf],
			[attr("length", 24), attr("special", false)],
		),
	);
	const body = [
		attr("identifier", `${dnsName(appTf)}-${dnsName(resourceName)}`),
		attr("engine", engine),
		attr("instance_class", DB_INSTANCE_CLASS),
		attr("allocated_storage", 20),
		attr("db_name", db),
		attr("username", "launchfile"),
		attr("password", ref("random_password", pwTf, "result")),
		attr("db_subnet_group_name", ref("aws_db_subnet_group", "main", "name")),
		attr("vpc_security_group_ids", [ref("aws_security_group", "rds", "id")]),
		attr("publicly_accessible", false),
		attr("skip_final_snapshot", true),
	];
	if (req.version)
		body.splice(
			2,
			0,
			attr("engine_version", req.version.replace(/[^0-9.]/g, "") || "16"),
		);
	blocks.push(block("resource", ["aws_db_instance", tf], body));

	const host = `\${aws_db_instance.${tf}.address}`;
	const pw = `\${random_password.${pwTf}.result}`;
	const scheme = engine === "postgres" ? "postgres" : "mysql";
	return {
		host,
		port,
		user: "launchfile",
		password: pw,
		name: db,
		url: `${scheme}://launchfile:${pw}@${host}:${port}/${db}`,
	};
}

function emitElastiCache(
	blocks: string[],
	appTf: string,
	resourceName: string,
): Record<string, string | number> {
	const tf = `${appTf}_${tfName(resourceName)}`;
	blocks.push(
		block(
			"resource",
			["aws_elasticache_cluster", tf],
			[
				attr("cluster_id", `${dnsName(appTf)}-${dnsName(resourceName)}`),
				attr("engine", "redis"),
				attr("node_type", CACHE_NODE_TYPE),
				attr("num_cache_nodes", 1),
				attr("parameter_group_name", "default.redis7"),
				attr("port", 6379),
				attr(
					"subnet_group_name",
					ref("aws_elasticache_subnet_group", "main", "name"),
				),
				attr("security_group_ids", [ref("aws_security_group", "cache", "id")]),
			],
		),
	);
	const host = `\${aws_elasticache_cluster.${tf}.cache_nodes[0].address}`;
	// The cluster runs with no AUTH token, so the honest password is empty. The
	// property is still exposed: SPEC.md § Resource Property Vocabulary makes it
	// a MUST for every provider that supports redis.
	return { host, port: 6379, password: "", url: `redis://${host}:6379` };
}

function emitComponent(
	blocks: string[],
	c: Conformance,
	launch: NormalizedLaunch,
	name: string,
	comp: NormalizedComponent,
	appTf: string,
	baseContext: ResolverContext,
	targetGroupFor: Record<string, string>,
	m: MintContext,
): void {
	const compTf = tfName(name);
	const instanceTf = `${appTf}_${compTf}`;
	const serviceName =
		name === "default" ? launch.name : `${launch.name}-${name}`;

	// Mode resolution: this provider is artifact-only and builds from the contract.
	if (comp.build?.dockerfile || comp.build?.target || comp.build?.args) {
		c.ignore(
			"build.dockerfile/target/args",
			"OCI specialization ignored — EC2 builds from the portable runtime+commands contract (D-40 / RFC C)",
			name,
		);
	}
	if (comp.source || comp.commands?.install || comp.commands?.dev) {
		c.ignore(
			"source/install/dev",
			"source-mode fields ignored — provider runs in artifact mode (D-38)",
			name,
		);
	}

	// PROVIDERS.md §10 rule 8 (D-52): report unsupplied `required` env vars before
	// the mode gaps below can return. A component this probe cannot translate still
	// has an environment contract the operator must satisfy, and dropping it because
	// the component gapped for an unrelated reason is the silent drop the rule
	// forbids. `resourceMap` is fully populated before this loop, so the arrival
	// test below is decidable here.
	reportUnsuppliedRequired(comp, name, c, baseContext);
	// host capabilities a bare-EC2 target can't honor. Both spellings are
	// graded identically (PROVIDERS.md §11): the D-44 entry form below, and the
	// legacy block after it.
	for (const req of comp.requires ?? []) {
		if (!req.host) continue;
		for (const [capability, value] of Object.entries(req.host)) {
			c.gap(
				`requires:host.${capability}`,
				"blocker",
				`component requires host capability ${capability}=${String(value)}; ` +
					"a bare EC2 target cannot grant it",
				"use an ECS/container provider",
				name,
			);
		}
	}
	for (const sup of comp.supports ?? []) {
		if (!sup.host) continue;
		for (const [capability, value] of Object.entries(sup.host)) {
			c.gap(
				`supports:host.${capability}`,
				"nice-to-have",
				`optional host capability ${capability}=${String(value)} is not granted; ` +
					"the component runs degraded",
				"use an ECS/container provider if the capability is needed",
				name,
			);
		}
	}
	if (comp.host?.docker === "required") {
		c.gap(
			"host.docker",
			"blocker",
			"component requires a Docker socket; bare EC2 has none",
			"use an ECS/container provider",
			name,
		);
	}

	if (!comp.runtime && comp.image) {
		c.gap(
			"image",
			"workaround",
			"prebuilt OCI image with no portable runtime+commands contract; this probe builds on EC2 from the contract, not a container host",
			"add runtime+commands for a portable build path, or target a container provider",
			name,
		);
		return;
	}
	if (!comp.runtime && !comp.commands?.start) {
		c.gap(
			"runtime",
			"blocker",
			"no runtime and no commands.start — nothing to build or run on EC2",
			undefined,
			name,
		);
		return;
	}

	// Per-component resolver context adds storage paths (D-39).
	const storageCtx: ResolverContext = comp.storage
		? {
				...baseContext,
				storage: Object.fromEntries(
					Object.entries(comp.storage).map(([n, v]) => [n, { path: v.path }]),
				),
			}
		: baseContext;

	// requires/depends_on → Terraform ordering.
	const dependsOn: HclValue[] = [];
	for (const req of comp.requires ?? []) {
		if (req.host) continue; // capability, not a backing service (D-44)
		const spec = MANAGED_RESOURCES[req.type];
		if (!spec) continue;
		const resourceName = req.name ?? req.type;
		const tf = `${appTf}_${tfName(resourceName)}`;
		dependsOn.push(
			spec.kind === "rds"
				? ref("aws_db_instance", tf)
				: ref("aws_elasticache_cluster", tf),
		);
	}
	for (const dep of comp.depends_on ?? []) {
		dependsOn.push(ref("aws_instance", `${appTf}_${tfName(dep.component)}`));
		c.map(`depends_on:${dep.component}`, "terraform depends_on", name);
	}

	// Security group: ingress for each provides port, egress all.
	const ingress: string[] = [];
	for (const p of comp.provides ?? []) {
		ingress.push(
			block(
				"ingress",
				[],
				[
					attr("from_port", p.port),
					attr("to_port", p.port),
					attr("protocol", "tcp"),
					attr("cidr_blocks", [VPC_CIDR]),
				],
			),
		);
		c.map(
			`provides:${p.protocol}:${p.port}`,
			"aws_security_group ingress",
			name,
		);
	}
	blocks.push(
		block(
			"resource",
			["aws_security_group", instanceTf],
			[
				attr("name", `${dnsName(appTf)}-${dnsName(name)}`),
				attr("vpc_id", ref("aws_vpc", "main", "id")),
				...ingress,
				block(
					"egress",
					[],
					[
						attr("from_port", 0),
						attr("to_port", 0),
						attr("protocol", "-1"),
						attr("cidr_blocks", ["0.0.0.0/0"]),
					],
				),
			],
		),
	);

	// EC2 instance with cloud-init.
	const instanceBody: string[] = [
		attr("ami", ref("data.aws_ami.al2023", "id")),
		attr("instance_type", INSTANCE_TYPE),
		attr("subnet_id", ref("aws_subnet", "public_a", "id")),
		attr("vpc_security_group_ids", [
			ref("aws_security_group", instanceTf, "id"),
		]),
		attr("user_data", heredoc(cloudInit(comp, serviceName))),
		attr("tags", { Name: serviceName }),
	];
	if (dependsOn.length > 0) instanceBody.push(attr("depends_on", dependsOn));
	blocks.push(block("resource", ["aws_instance", instanceTf], instanceBody));
	c.map(
		comp.runtime ? `runtime:${comp.runtime}` : "commands.start",
		"aws_instance (cloud-init)",
		name,
	);
	if (comp.commands?.start)
		c.map("commands.start", "systemd unit (run slot)", name);
	if (comp.restart)
		c.map(
			"restart",
			`systemd Restart=${RESTART_DIRECTIVE[comp.restart]}`,
			name,
		);
	if (comp.commands?.build)
		c.map("commands.build", "cloud-init (prepare slot)", name);
	if (comp.commands?.release)
		c.map("commands.release", "cloud-init (release slot)", name);

	// storage → EBS volumes.
	if (comp.storage) {
		let device = 0;
		for (const [volName, vol] of Object.entries(comp.storage)) {
			const volTf = `${instanceTf}_${tfName(volName)}`;
			blocks.push(
				block(
					"resource",
					["aws_ebs_volume", volTf],
					[
						attr(
							"availability_zone",
							raw("data.aws_availability_zones.available.names[0]"),
						),
						attr("size", 10),
						attr("tags", {
							Name: `${serviceName}-${volName}`,
							MountPath: vol.path,
						}),
					],
				),
			);
			blocks.push(
				block(
					"resource",
					["aws_volume_attachment", volTf],
					[
						attr("device_name", `/dev/sd${String.fromCharCode(102 + device)}`),
						attr("volume_id", ref("aws_ebs_volume", volTf, "id")),
						attr("instance_id", ref("aws_instance", instanceTf, "id")),
					],
				),
			);
			device += 1;
			c.map(`storage:${volName}`, "aws_ebs_volume", name);
		}
	}

	// env + set_env → SSM Parameter Store / SecureString.
	const resolvedEnv: Record<string, { value: string; sensitive: boolean }> = {};
	if (comp.env) {
		for (const [key, envVar] of Object.entries(comp.env)) {
			const resolved = resolveEnvVar(
				blocks,
				instanceTf,
				key,
				envVar,
				storageCtx,
				name,
				m,
			);
			if (resolved) resolvedEnv[key] = resolved;
		}
	}
	for (const req of comp.requires ?? []) {
		if (req.host) continue; // ungranted capability — its set_env is omitted (D-44)
		if (!req.set_env) continue;
		const resourceName = req.name ?? req.type;
		const resourceProps = baseContext.resources?.[resourceName];
		if (!resourceProps) continue;
		const scoped: ResolverContext = { ...storageCtx, resource: resourceProps };
		for (const [envKey, expr] of Object.entries(req.set_env)) {
			resolvedEnv[envKey] = {
				value: resolveExpression(expr, scoped),
				sensitive: true,
			};
		}
	}

	for (const [key, { value, sensitive }] of Object.entries(resolvedEnv)) {
		const paramTf = `${instanceTf}_${tfName(key)}`;
		blocks.push(
			block(
				"resource",
				["aws_ssm_parameter", paramTf],
				[
					attr("name", `/launchfile/${launch.name}/${name}/${key}`),
					attr("type", sensitive ? "SecureString" : "String"),
					attr("value", toHcl(value)),
				],
			),
		);
	}
	if (Object.keys(resolvedEnv).length > 0)
		c.map("env", "aws_ssm_parameter", name);

	// health → recorded; the ALB target group carries the actual check.
	if (comp.health) c.map("health", "aws_lb_target_group health_check", name);

	if (comp.schedule) {
		c.gap(
			"schedule",
			"nice-to-have",
			"cron schedule not mapped (no EventBridge Scheduler in this probe)",
			"map to aws_scheduler_schedule",
			name,
		);
	}

	// Stash the instance ref so the ALB can attach it.
	targetGroupFor[name] = instanceTf;
}

/**
 * Record a conformance gap for each `required` env var the Launchfile supplies no
 * value for — PROVIDERS.md §10 rule 8 / D-52.
 *
 * A variable is unsupplied when no `generator:`, no `default:`, and no `set_env:`
 * binding *yields* it. The test is arrival, not declaration, so a binding counts
 * only when the resource behind it resolved: the injection loop skips any resource
 * absent from the context, and `supports:` resources are never provisioned by this
 * probe at all (SPEC.md §Supports). A binding on an unmappable type therefore
 * declares the key without ever supplying it.
 */
function reportUnsuppliedRequired(
	comp: NormalizedComponent,
	name: string,
	c: Conformance,
	baseContext: ResolverContext,
): void {
	// The keys that really arrive: a binding counts only when the resource behind
	// it resolved. The predicate itself is the SDK's, shared with every other
	// provider and the catalog harness (D-52).
	const boundBySetEnv = (comp.requires ?? [])
		.filter((req) => baseContext.resources?.[req.name ?? req.type])
		.flatMap((req) => Object.keys(req.set_env ?? {}));
	for (const { key, sensitive } of unsuppliedRequiredEnv(comp, boundBySetEnv)) {
		c.gap(
			`env.${key}`,
			sensitive ? "blocker" : "workaround",
			sensitive
				? "required sensitive env var with no default, generator, or set_env binding — substituting a value would make this a publicly known constant credential (D-18), so it must be supplied out of band"
				: "required env var with no default, generator, or set_env binding — the operator must supply the value",
			"supply it at apply time (SSM parameter or TF variable), or give the Launchfile a `default:` or `generator:`",
			name,
		);
	}
}

function resolveEnvVar(
	blocks: string[],
	instanceTf: string,
	key: string,
	envVar: NormalizedEnvVar,
	context: ResolverContext,
	component: string,
	m: MintContext,
): { value: string; sensitive: boolean } | undefined {
	if (envVar.generator) {
		const tf = `${instanceTf}_${tfName(key)}_gen`;
		const { value } = emitGenerator(
			blocks,
			tf,
			envVar.generator,
			{ app: m.app, component, variable: key },
			m,
		);
		return { value, sensitive: true };
	}
	if (envVar.default !== undefined) {
		const raw = String(envVar.default);
		const value = isExpression(raw) ? resolveExpression(raw, context) : raw;
		return { value, sensitive: envVar.sensitive === true };
	}
	// PROVIDERS.md §10 rule 8 (D-52): an unsupplied `required` value is a gap to
	// report, never a value to invent. Returning undefined leaves it out of the
	// emitted SSM parameters; the gap is recorded by the caller, after `set_env`
	// has had its chance to supply the key.
	return undefined;
}

function emitAlb(
	blocks: string[],
	c: Conformance,
	appTf: string,
	launch: NormalizedLaunch,
	exposedComponents: string[],
	targetGroupFor: Record<string, string>,
): void {
	blocks.push(
		block(
			"resource",
			["aws_security_group", "alb"],
			[
				attr("name", `${dnsName(appTf)}-alb`),
				attr("vpc_id", ref("aws_vpc", "main", "id")),
				block(
					"ingress",
					[],
					[
						attr("from_port", 80),
						attr("to_port", 80),
						attr("protocol", "tcp"),
						attr("cidr_blocks", ["0.0.0.0/0"]),
					],
				),
				block(
					"egress",
					[],
					[
						attr("from_port", 0),
						attr("to_port", 0),
						attr("protocol", "-1"),
						attr("cidr_blocks", ["0.0.0.0/0"]),
					],
				),
			],
		),
	);
	blocks.push(
		block(
			"resource",
			["aws_lb", "main"],
			[
				attr("load_balancer_type", "application"),
				attr("security_groups", [ref("aws_security_group", "alb", "id")]),
				attr("subnets", [
					ref("aws_subnet", "public_a", "id"),
					ref("aws_subnet", "public_b", "id"),
				]),
			],
		),
	);
	c.map("provides.exposed", "aws_lb (ALB)");

	const usedListenerPorts = new Set<number>();
	for (const [idx, name] of exposedComponents.entries()) {
		const comp = launch.components[name];
		const instanceTf = targetGroupFor[name];
		if (!comp || !instanceTf) continue; // component was gapped (e.g. image-only)
		const provide = (comp.provides ?? []).find((p) => p.exposed === true);
		if (!provide) continue;
		const tgTf = `${appTf}_${tfName(name)}`;
		const healthPath = comp.health?.path ?? "/";

		blocks.push(
			block(
				"resource",
				["aws_lb_target_group", tgTf],
				[
					attr("port", provide.port),
					attr("protocol", "HTTP"),
					attr("vpc_id", ref("aws_vpc", "main", "id")),
					attr("target_type", "instance"),
					block(
						"health_check",
						[],
						[attr("path", healthPath), attr("matcher", "200-399")],
					),
				],
			),
		);
		blocks.push(
			block(
				"resource",
				["aws_lb_target_group_attachment", tgTf],
				[
					attr("target_group_arn", ref("aws_lb_target_group", tgTf, "arn")),
					attr("target_id", ref("aws_instance", instanceTf, "id")),
					attr("port", provide.port),
				],
			),
		);

		// Primary exposed component listens on :80; others on their own port.
		const listenerPort = idx === 0 ? 80 : provide.port;
		if (usedListenerPorts.has(listenerPort)) continue;
		usedListenerPorts.add(listenerPort);
		blocks.push(
			block(
				"resource",
				["aws_lb_listener", tgTf],
				[
					attr("load_balancer_arn", ref("aws_lb", "main", "arn")),
					attr("port", listenerPort),
					attr("protocol", "HTTP"),
					block(
						"default_action",
						[],
						[
							attr("type", "forward"),
							attr("target_group_arn", ref("aws_lb_target_group", tgTf, "arn")),
						],
					),
				],
			),
		);
		c.map(`provides.exposed:${name}`, "aws_lb_target_group + listener", name);
	}
}
