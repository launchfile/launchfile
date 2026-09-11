import { describe, expect, it } from "vitest";
import {
	boundCertificate,
	certificateBindings,
	effectiveListener,
} from "../effective-listener.js";
import { readLaunch, validateLaunch } from "../reader.js";
import { LaunchSchema } from "../schema.js";
import { writeLaunch } from "../writer.js";

/**
 * D-61: a `provides` entry may bind one `supports:` entry of type
 * `certificate`, and while that binding is active the entry's EFFECTIVE
 * protocol is `https`. The declared fields never move.
 */

/** gitea's shape: the binding, the collision it creates with `env:`, the lot. */
const GITEA = {
	version: "launch/v1",
	name: "gitea",
	image: "gitea/gitea:latest",
	provides: [
		{ name: "web", protocol: "http", port: 3000, exposed: true, tls: "server-cert" },
		{ name: "metrics", protocol: "http", port: 9090 },
		{ name: "ssh", protocol: "tcp", port: 22, exposed: true },
	],
	supports: [
		{
			name: "server-cert",
			type: "certificate",
			set_env: {
				GITEA__server__PROTOCOL: "https",
				GITEA__server__HTTP_PORT: "3000",
				GITEA__server__CERT_FILE: "$cert_file",
				GITEA__server__KEY_FILE: "$key_file",
			},
		},
	],
	env: { GITEA__server__PROTOCOL: "http" },
};

/** Every issue message the schema produced, joined for substring assertions. */
function errorsFor(input: unknown): string {
	const result = LaunchSchema.safeParse(input);
	expect(result.success).toBe(false);
	return result.error!.issues.map((i) => i.message).join("\n");
}

describe("`tls:` accepts both spellings (D-61 rule 1)", () => {
	it("accepts the string shorthand", () => {
		expect(LaunchSchema.safeParse(GITEA).success).toBe(true);
	});

	it("accepts the explicit `{ certificate: <name> }` expansion", () => {
		const expanded = structuredClone(GITEA) as Record<string, unknown>;
		(expanded.provides as Array<Record<string, unknown>>)[0]!.tls = {
			certificate: "server-cert",
		};
		expect(LaunchSchema.safeParse(expanded).success).toBe(true);
	});

	it("rejects an unknown key inside the expansion", () => {
		const bad = structuredClone(GITEA) as Record<string, unknown>;
		(bad.provides as Array<Record<string, unknown>>)[0]!.tls = {
			certificate: "server-cert",
			port: 8443,
		};
		expect(LaunchSchema.safeParse(bad).success).toBe(false);
	});

	it("survives a parse → serialize round trip in both spellings", () => {
		const yaml = writeLaunch(validateLaunch(GITEA));
		expect(yaml).toContain("tls: server-cert");
		const reread = readLaunch(yaml);
		expect(boundCertificate(reread.components.default!.provides![0]!)).toBe(
			"server-cert",
		);
	});
});

describe("structural rules the schema enforces (D-61 rule 1)", () => {
	it("names an entry that exists in the same component's `supports:`", () => {
		const bad = structuredClone(GITEA) as Record<string, unknown>;
		(bad.provides as Array<Record<string, unknown>>)[0]!.tls = "missing-cert";
		const message = errorsFor(bad);
		expect(message).toContain("`tls: missing-cert` names no `supports:` entry");
		expect(message).toContain("server-cert");
	});

	it("requires the named entry to declare `type: certificate`", () => {
		const bad = structuredClone(GITEA) as Record<string, unknown>;
		(bad.supports as Array<Record<string, unknown>>)[0]!.type = "redis";
		expect(errorsFor(bad)).toContain("`type: redis`");
	});

	it("rejects one certificate named by two `provides` entries", () => {
		const bad = structuredClone(GITEA) as Record<string, unknown>;
		(bad.provides as Array<Record<string, unknown>>)[1]!.tls = "server-cert";
		const message = errorsFor(bad);
		expect(message).toContain(
			'certificate "server-cert" is bound by two `provides` entries',
		);
		expect(message).toContain('"web"');
		expect(message).toContain('"metrics"');
	});

	it("names the twin by index when the entries are unnamed", () => {
		const bad = {
			version: "launch/v1",
			name: "twin",
			image: "x",
			provides: [
				{ protocol: "http", port: 3000, tls: "cert" },
				{ protocol: "http", port: 3001, tls: "cert" },
			],
			supports: [{ name: "cert", type: "certificate" }],
		};
		expect(errorsFor(bad)).toContain("#1 (unnamed)");
	});

	it("rejects a binding that names a `requires:` entry, and says where it went", () => {
		const bad = structuredClone(GITEA) as Record<string, unknown>;
		bad.requires = [{ name: "server-cert", type: "certificate" }];
		bad.supports = [];
		const message = errorsFor(bad);
		expect(message).toContain("names a `requires:` entry");
		expect(message).toContain("Required native TLS is out of scope");
		expect(message).toContain("issues/314");
	});

	it("resolves per component, not across the app", () => {
		const bad = {
			version: "launch/v1",
			name: "split",
			components: {
				web: {
					image: "web",
					provides: [{ name: "web", protocol: "http", port: 80, tls: "cert" }],
				},
				worker: {
					image: "worker",
					supports: [{ name: "cert", type: "certificate" }],
				},
			},
		};
		expect(errorsFor(bad)).toContain("names no `supports:` entry on web");
	});

	for (const protocol of ["tcp", "udp"]) {
		it(`rejects a binding on a \`${protocol}\` listener, naming the entry`, () => {
			const bad = structuredClone(GITEA) as Record<string, unknown>;
			const entries = bad.provides as Array<Record<string, unknown>>;
			entries[0]!.protocol = protocol;
			const message = errorsFor(bad);
			expect(message).toContain("`tls: server-cert` binds `provides` entry");
			expect(message).toContain('"web"');
			expect(message).toContain(`\`protocol: ${protocol}\``);
			expect(message).toContain("`http`, `https`, `ws`, `grpc`");
		});
	}

	for (const protocol of ["http", "https", "ws", "grpc"]) {
		it(`accepts a binding on an \`${protocol}\` listener`, () => {
			const ok = structuredClone(GITEA) as Record<string, unknown>;
			(ok.provides as Array<Record<string, unknown>>)[0]!.protocol = protocol;
			expect(LaunchSchema.safeParse(ok).success).toBe(true);
		});
	}

	it("names an unnamed `tcp` entry by index", () => {
		const bad = {
			version: "launch/v1",
			name: "socket",
			image: "x",
			provides: [{ protocol: "tcp", port: 5432, tls: "db-cert" }],
			supports: [{ name: "db-cert", type: "certificate" }],
		};
		expect(errorsFor(bad)).toContain("#1 (unnamed)");
	});

	it("accepts the same certificate name on two different components", () => {
		const ok = {
			version: "launch/v1",
			name: "pair",
			components: {
				a: {
					image: "a",
					provides: [{ name: "web", protocol: "http", port: 80, tls: "cert" }],
					supports: [{ name: "cert", type: "certificate" }],
				},
				b: {
					image: "b",
					// A distinct endpoint name: `provides[].name` is app-wide
					// (D-63 rule 4), while a certificate name is component-local.
					provides: [{ name: "admin", protocol: "http", port: 80, tls: "cert" }],
					supports: [{ name: "cert", type: "certificate" }],
				},
			},
		};
		expect(LaunchSchema.safeParse(ok).success).toBe(true);
	});
});

describe("declared versus effective listener (D-61 rule 2)", () => {
	const entry = { name: "web", protocol: "http", port: 3000, tls: "server-cert" } as const;

	it("reads the declared values when nothing is active", () => {
		const listener = effectiveListener(entry);
		expect(listener).toMatchObject({
			declaredProtocol: "http",
			declaredPort: 3000,
			protocol: "http",
			port: 3000,
			certificate: "server-cert",
			active: false,
		});
	});

	it("reads `https` on the declared port when the binding is active", () => {
		const listener = effectiveListener(entry, new Set(["server-cert"]));
		expect(listener).toMatchObject({
			declaredProtocol: "http",
			declaredPort: 3000,
			protocol: "https",
			port: 3000,
			active: true,
		});
	});

	it("leaves an entry that binds nothing alone, whatever is active", () => {
		const plain = { protocol: "tcp", port: 22 } as const;
		expect(effectiveListener(plain, ["server-cert"])).toMatchObject({
			protocol: "tcp",
			port: 22,
			certificate: undefined,
			active: false,
		});
	});

	it("does not activate a binding whose certificate is merely declared", () => {
		expect(effectiveListener(entry, new Set(["other-cert"])).active).toBe(false);
	});

	it("collects a component's bindings in declaration order", () => {
		const launch = validateLaunch(GITEA);
		expect(certificateBindings(launch.components.default!)).toEqual([
			{ entry: launch.components.default!.provides![0], certificate: "server-cert" },
		]);
	});
});

describe("`certificate` composes with `https-origin` (D-61 rule 4)", () => {
	it("validates a file declaring both, and neither satisfies the other", () => {
		const both = {
			version: "launch/v1",
			name: "gitea",
			image: "gitea/gitea:latest",
			provides: [
				{ name: "web", protocol: "http", port: 3000, exposed: true, tls: "server-cert" },
			],
			supports: [
				{
					name: "server-cert",
					type: "certificate",
					set_env: { GITEA__server__CERT_FILE: "$cert_file" },
				},
				{ type: "https-origin", endpoint: "web", set_env: { ROOT_URL: "$url" } },
			],
		};
		expect(LaunchSchema.safeParse(both).success).toBe(true);

		const launch = validateLaunch(both);
		const supports = launch.components.default!.supports!;
		// Two entries, two types, two resource names: nothing collapses one into
		// the other, which is what "does not imply" means structurally.
		expect(supports.map((s) => s.type)).toEqual(["certificate", "https-origin"]);
		expect(supports.map((s) => s.name ?? s.type)).toEqual([
			"server-cert",
			"https-origin",
		]);
	});
});

describe("output is unchanged for a file that declares no `tls:` (P-13)", () => {
	it("round-trips a certificate-free file byte for byte", () => {
		const plain = {
			version: "launch/v1",
			name: "plain",
			image: "nginx",
			provides: [{ protocol: "http", port: 80, exposed: true }],
		};
		const once = writeLaunch(validateLaunch(plain));
		expect(once).not.toContain("tls");
		expect(writeLaunch(readLaunch(once))).toBe(once);
	});
});
