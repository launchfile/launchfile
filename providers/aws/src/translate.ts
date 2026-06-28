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
	resolveExpression,
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

export interface TranslateOptions {
	/** AWS region for the provider block. Default: us-east-1. */
	region?: string;
}

export interface TranslateResult {
	/** The generated Terraform document. */
	hcl: string;
	/** The conformance ledger: what mapped, gapped, and was ignored. */
	conformance: Conformance;
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

/** Lowercase, DNS-safe identifier for AWS resource names (RDS identifiers, cache cluster ids). */
function dnsName(name: string): string {
	const cleaned = name
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
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
	lines.push("Restart=always");
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
			secretValues[name] = emitGenerator(blocks, tf, secret.generator);
			c.map(
				`secrets.${name}`,
				secret.generator === "uuid" ? "random_uuid" : "random_password",
			);
		}
	}

	// --- Resolver context (provider supplies home-#3 values) ---
	const resourceMap: Record<string, Record<string, string | number>> = {};
	const componentMap: Record<string, Record<string, string | number>> = {};
	const baseContext: ResolverContext = {
		resources: resourceMap,
		components: componentMap,
		secrets: secretValues,
		app: appProps,
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
			const resourceName = req.name ?? req.type;
			if (provisioned.has(resourceName)) continue;
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
		);
	}

	// --- ALB fronting exposed provides ---
	if (hasAlb) {
		emitAlb(blocks, c, appTf, launch, exposedComponents, targetGroupFor);
	}

	return { hcl: document(blocks), conformance: c };
}

// ---------------------------------------------------------------------------
// Emitters — each appends Terraform blocks and returns any properties needed
// for expression resolution.
// ---------------------------------------------------------------------------

function emitGenerator(
	blocks: string[],
	tf: string,
	generator: string,
): string {
	if (generator === "uuid") {
		blocks.push(block("resource", ["random_uuid", tf], []));
		return `\${random_uuid.${tf}.result}`;
	}
	if (generator === "port") {
		blocks.push(
			block(
				"resource",
				["random_integer", tf],
				[attr("min", 1024), attr("max", 65535)],
			),
		);
		return `\${random_integer.${tf}.result}`;
	}
	// "secret"
	blocks.push(
		block(
			"resource",
			["random_password", tf],
			[attr("length", 32), attr("special", false)],
		),
	);
	return `\${random_password.${tf}.result}`;
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
						attr("random", { source: "hashicorp/random", version: "~> 3.0" }),
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
	return { host, port: 6379, url: `redis://${host}:6379` };
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
			);
			if (resolved) resolvedEnv[key] = resolved;
		}
	}
	for (const req of comp.requires ?? []) {
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

	// host capabilities a bare-EC2 target can't honor.
	if (comp.host?.docker === "required") {
		c.gap(
			"host.docker",
			"blocker",
			"component requires a Docker socket; bare EC2 has none",
			"use an ECS/container provider",
			name,
		);
	}
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

function resolveEnvVar(
	blocks: string[],
	instanceTf: string,
	key: string,
	envVar: NormalizedEnvVar,
	context: ResolverContext,
): { value: string; sensitive: boolean } | undefined {
	if (envVar.generator) {
		const tf = `${instanceTf}_${tfName(key)}_gen`;
		const value = emitGenerator(blocks, tf, envVar.generator);
		return { value, sensitive: true };
	}
	if (envVar.default !== undefined) {
		const raw = String(envVar.default);
		const value = isExpression(raw) ? resolveExpression(raw, context) : raw;
		return { value, sensitive: envVar.sensitive === true };
	}
	if (envVar.required) {
		const lower = key.toLowerCase();
		const placeholder =
			lower.includes("url") || lower.includes("origin")
				? "http://localhost"
				: "PLACEHOLDER";
		return { value: placeholder, sensitive: envVar.sensitive === true };
	}
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
