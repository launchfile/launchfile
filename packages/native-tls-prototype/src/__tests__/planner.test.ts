import { readLaunch, resolveExpression } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { planTls, type CertificateInput, type TlsMode, type TlsOptions } from "../planner.js";

const material: CertificateInput = {
	certFile: "/run/launchfile/server.crt",
	keyFile: "/run/launchfile/server.key",
	caFile: "/run/launchfile/ca.crt",
};

function document() {
	return {
		name: "gitea",
		image: "gitea/gitea:latest",
		provides: [
			{ name: "web", protocol: "http", port: 3000, exposed: true, tls: "server-cert" as unknown },
		],
		supports: [{
			name: "server-cert", type: "certificate",
			set_env: { PROTOCOL: "https", CERT: "$cert_file", KEY: "$key_file", HTTP_PORT: "$listener.port" },
		}],
		env: { PROTOCOL: "http", ROOT_URL: "$app.url" },
		health: "/api/healthz",
	};
}

function options(mode: TlsMode = "native", extra: Partial<TlsOptions> = {}): TlsOptions {
	return { mode, publicUrl: `${mode === "off" ? "http" : "https"}://gitea.example.test`,
		certificates: { "server-cert": material }, ...extra };
}

describe("TLS plans", () => {
	it.each([
		["off", "http", false], ["edge", "http", false], ["native", "https", true],
		["passthrough", "https", true], ["reencrypt", "https", true],
	] as const)("%s selects the correct app listener and certificate wiring", (mode, protocol, active) => {
		const plan = planTls(stringify(document()), options(mode));
		expect(plan).toMatchObject({ mode, protocol, port: 3000, component: "default", endpoint: "web" });
		expect(plan.launch.components.default!.provides).toEqual([
			{ name: "web", protocol, port: 3000, exposed: true },
		]);
		expect(plan.certificate).toBe(active ? "server-cert" : undefined);
		const component = plan.launch.components.default!;
		const effective = Object.fromEntries(Object.entries(component.env!).map(([key, value]) => [key, value.default]));
		for (const dependency of component.supports ?? []) {
			for (const [key, value] of Object.entries(dependency.set_env ?? {})) {
				effective[key] = resolveExpression(value, { resource: plan.resources[dependency.name!]!.properties });
			}
		}
		expect(effective.PROTOCOL).toBe(active ? "https" : "http");
		expect(effective.CERT).toBe(active ? material.certFile : undefined);
		expect(effective.HTTP_PORT).toBe(active ? "3000" : undefined);
		expect(component.health).toEqual(readLaunch(stringify(document())).components.default!.health);
		expect(plan.resources).toEqual(active ? { "server-cert": { properties: {
			cert_file: material.certFile, key_file: material.keyFile,
		} } } : {});
	});

	it("preserves an ordinary HTTP Launchfile and unrelated optional resources", () => {
		const source = `name: ordinary\nimage: nginx\nprovides:\n  - protocol: http\n    port: 80\n    exposed: true\nsupports:\n  - redis\nhealth: /\n`;
		const plan = planTls(source, options("off"));
		expect(plan.launch).toEqual(readLaunch(source));
		expect(plan.endpoint).toBe("80");
	});

	it("does not activate or inspect unused certificate material in HTTP modes", () => {
		const plan = planTls(stringify(document()), options("edge", {
			certificates: { "server-cert": { certFile: "invalid", keyFile: "", caFile: "" } },
		}));
		expect(plan.protocol).toBe("http");
		expect(plan.resources).toEqual({});
		expect(plan.launch.components.default!.supports).toEqual([]);
	});

	it("changes the endpoint and supplied port together without adding a second listener", () => {
		const app = document();
		app.provides[0]!.tls = { certificate: "server-cert", port: 3443 };
		const plan = planTls(stringify(app), options());
		expect(plan.port).toBe(3443);
		expect(plan.launch.components.default!.provides).toHaveLength(1);
		expect(plan.launch.components.default!.provides![0]!.port).toBe(3443);
		expect(plan.launch.components.default!.supports![0]!.set_env!.HTTP_PORT).toBe("3443");
		expect(plan.resources["server-cert"]!.properties).not.toHaveProperty("port");
		expect(planTls(stringify(app), options("off")).port).toBe(3000);
	});

	it("supports unnamed legacy endpoints with a consistent resolved identifier", () => {
		const app = document();
		const { name: _name, ...endpoint } = app.provides[0]!;
		const plan = planTls(stringify({ ...app, provides: [{ ...endpoint, tls: { certificate: "server-cert", port: 3443 } }] }), options());
		expect(plan.endpoint).toBe("3443");
	});

	it("keeps unrelated endpoints unchanged", () => {
		const app = document();
		const other = { name: "ssh", protocol: "tcp", port: 22, exposed: true };
		const plan = planTls(stringify({ ...app, provides: [...app.provides, other] }), options());
		expect(plan.launch.components.default!.provides![1]).toEqual(other);
	});

	it("normalizes a public URL while retaining a deployment subpath", () => {
		expect(planTls(stringify(document()), options("native", { publicUrl: "https://GITEA.example.test:443/" })).publicUrl)
			.toBe("https://gitea.example.test");
		expect(planTls(stringify(document()), options("native", { publicUrl: "https://gitea.example.test/git/" })).publicUrl)
			.toBe("https://gitea.example.test/git/");
	});

	it("does not mutate caller options and can compile the same document back to HTTP", () => {
		const input = Object.freeze({ mode: "native" as const, publicUrl: "https://gitea.example.test",
			certificates: Object.freeze({ "server-cert": Object.freeze({ ...material }) }) });
		const source = stringify(document());
		const plan = planTls(source, input);
		plan.resources["server-cert"]!.properties.cert_file = "/elsewhere";
		plan.warnings.push("changed");
		expect(input.certificates["server-cert"].certFile).toBe(material.certFile);
		expect(planTls(source, input).warnings).toEqual([]);
		expect(planTls(source, options("off")).protocol).toBe("http");
	});
});

describe("fail closed before legacy normalization", () => {
	it.each([true, null, [], {}, { certificate: "server-cert", verify: false },
		{ certificate: "server-cert", port: 0 }, { certificate: "server-cert", port: 65536 },
		{ certificate: "server-cert", port: 3.5 }, { certificate: "server-cert", port: "3443" },
		{ certificate: "server-cert", ports: [3443] }])("rejects unsupported TLS syntax %j", (tls) => {
		const app = document(); app.provides[0]!.tls = tls;
		expect(() => planTls(stringify(app), options("off"))).toThrow();
	});

	it.each(["root", "component"])("rejects %s variants explicitly", (scope) => {
		const app = document();
		const source = scope === "root" ? { ...app, variants: {} }
			: { name: app.name, components: { app: { ...app, variants: {} } } };
		expect(() => planTls(stringify(source), options())).toThrow(/variants.*separate proposal/);
	});

	it.each(["tls", "public"])("rejects misplaced %s on a component", (field) => {
		expect(() => planTls(stringify({ ...document(), [field]: {} }), options())).toThrow(/belongs/);
	});

	it.each(["tcp", "udp", "grpc", "ws"])("refuses extending %s through this HTTP TLS shorthand", (protocol) => {
		const app = document(); app.provides[0]!.protocol = protocol;
		expect(() => planTls(stringify(app), options())).toThrow(/only HTTP\/HTTPS/);
	});

	it.each(["missing", "wrong-type", "duplicate"])("rejects a %s certificate dependency even in HTTP mode", (kind) => {
		const app = document();
		if (kind === "missing") app.supports = [];
		if (kind === "wrong-type") app.supports[0]!.type = "postgres";
		if (kind === "duplicate") app.supports.push({ ...app.supports[0]! });
		expect(() => planTls(stringify(app), options("off"))).toThrow(/exactly one certificate dependency/);
	});

	it.each(["requires", "supports"])("refuses separate public contracts in %s before SDK normalization", (field) => {
		expect(() => planTls(stringify({ ...document(), [field]: [{ public: { endpoint: "web", scheme: "https" } }] }), options("edge")))
			.toThrow(/Public HTTPS requirements are a separate prototype/);
	});

	it("rejects TLS defaults that the SDK would ignore in multi-component files", () => {
		expect(() => planTls(stringify({ ...document(), components: { app: document() } }), options()))
			.toThrow(/not inherited/);
	});

	it("checks a dangling binding on an endpoint that was not selected", () => {
		const app = document();
		app.provides.push({ name: "admin", protocol: "http", port: 3001, exposed: false, tls: "absent" });
		expect(() => planTls(stringify(app), options())).toThrow(/admin.tls.*absent/);
	});
});

describe("explicit deployment contracts", () => {
	it.each(["native", "off"] as const)("rejects legacy overloaded $port even when %s is selected", (mode) => {
		const app = document(); app.supports[0]!.set_env.HTTP_PORT = "$port";
		expect(() => planTls(stringify(app), options(mode))).toThrow(/\$port belongs to the resource; use \$listener.port/);
	});

	it.each(["$listener.host", "$listener.port.extra", "$listener"])("refuses unsupported listener reference %s", (reference) => {
		const app = document(); app.supports[0]!.set_env.HTTP_PORT = reference;
		expect(() => planTls(stringify(app), options("off"))).toThrow(/valid only inside/);
	});

	it.each(["native", "off"] as const)("refuses the listener namespace in ordinary env in %s mode", (mode) => {
		const app = document();
		const source = stringify({ ...app, env: { ...app.env, PORT: "$listener.port" } });
		expect(() => planTls(source, options(mode))).toThrow(/valid only inside/);
	});

	it("does not let another resource borrow the certificate's listener namespace", () => {
		const source = stringify({ ...document(), requires: [{ type: "redis", set_env: { REDIS_PORT: "$listener.port" } }] });
		expect(() => planTls(source, options())).toThrow(/valid only inside/);
	});

	it("resolves the listener namespace while preserving ordinary resource references, transforms, and escaped dollars", () => {
		const app = document();
		app.provides[0]!.tls = { certificate: "server-cert", port: 3443 };
		app.supports[0]!.set_env.HTTP_PORT = "$$literal:${listener.port}:${cert_file}:${listener.port|base64}";
		const plan = planTls(stringify(app), options());
		const value = plan.launch.components.default!.supports![0]!.set_env!.HTTP_PORT!;
		expect(resolveExpression(value, { resource: plan.resources["server-cert"]!.properties }))
			.toBe(`$literal:3443:${material.certFile}:${Buffer.from("3443", "hex").toString("base64")}`);
	});

	it("keeps $port as the ordinary backing resource port", () => {
		const source = stringify({ ...document(), requires: [{ type: "postgres", set_env: { PG_PORT: "$port" } }] });
		const plan = planTls(source, options());
		expect(plan.launch.components.default!.requires![0]!.set_env!.PG_PORT).toBe("$port");
	});

	it.each(["off", "edge"] as const)("a required certificate rejects %s", (mode) => {
		const { supports, ...app } = document();
		expect(() => planTls(stringify({ ...app, requires: supports }), options(mode)))
			.toThrow(/requires native TLS certificate/);
		expect(planTls(stringify({ ...app, requires: supports }), options()).launch.components.default!.requires)
			.toHaveLength(1);
	});

	it("rejects an unsupported explicit provider mode without operator strictness", () => {
		expect(() => planTls(stringify(document()), options("reencrypt", { supportedModes: ["off", "edge"] })))
			.toThrow(/does not support explicitly selected/);
	});

	it("refuses policy options belonging to the strictness RFC", () => {
		expect(() => planTls(stringify(document()), { ...options(), strict: true } as TlsOptions)).toThrow(/Operator strictness is a separate prototype/);
	});

	it.each(["native", "passthrough", "reencrypt"] as const)("%s refuses missing material instead of falling back to HTTP", (mode) => {
		expect(() => planTls(stringify(document()), options(mode, { certificates: {} }))).toThrow(/supplied certificate material/);
	});

	it.each(["certFile", "keyFile", "caFile"] as const)("requires an absolute %s container path", (key) => {
		for (const value of ["", "relative.pem", "/", "/cert/../key.pem", "/cert/./key.pem", "/cert/key\n.pem"]) {
			expect(() => planTls(stringify(document()), options("native", {
				certificates: { "server-cert": { ...material, [key]: value } },
			}))).toThrow(new RegExp(key));
		}
	});

	it.each(["http://gitea.example.test", "https://user:secret@gitea.example.test", "https://gitea.example.test?q=1",
		"https://gitea.example.test#fragment", "file:///tmp/app", "https:gitea.example.test", "not a url"])
	("rejects invalid or inconsistent native public URL %s", (publicUrl) => {
		expect(() => planTls(stringify(document()), options("native", { publicUrl }))).toThrow(/publicUrl/);
	});

	it("rejects HTTPS public URL in off mode", () => {
		expect(() => planTls(stringify(document()), options("off", { publicUrl: "https://gitea.example.test" })))
			.toThrow(/requires an http/);
	});

	it("refuses native mode when an app has no native TLS binding", () => {
		const app = document();
		const { tls: _tls, ...web } = app.provides[0]!;
		expect(() => planTls(stringify({ ...app, provides: [web], supports: [] }), options())).toThrow(/does not declare native TLS/);
	});

	it("cannot infer an HTTP configuration from an HTTPS base listener", () => {
		const app = document(); app.provides[0]!.protocol = "https";
		expect(() => planTls(stringify(app), options("edge"))).toThrow(/cannot downgrade/);
		expect(planTls(stringify(app), options()).protocol).toBe("https");
	});

	it("refuses a port replacement that collides with another listener", () => {
		const app = document(); app.provides[0]!.tls = { certificate: "server-cert", port: 3443 };
		const source = stringify({ ...app, provides: [...app.provides, { name: "metrics", protocol: "http", port: 3443 }] });
		expect(() => planTls(source, options())).toThrow(/conflicts.*port 3443/);
	});

	it("refuses conflicting certificate and backing-service environment wiring", () => {
		const source = stringify({ ...document(), requires: [{ type: "postgres", set_env: { PROTOCOL: "postgres" } }] });
		expect(() => planTls(source, options())).toThrow(/conflicting set_env wiring/);
	});

	it("refuses misspelled certificate resource properties", () => {
		const app = document(); app.supports[0]!.set_env.CERT = "$cert_fil";
		expect(() => planTls(stringify(app), options())).toThrow(/unknown certificate property cert_fil/);
	});

	it("does not silently empty an inactive certificate reference outside conditional wiring", () => {
		const app = document();
		const source = stringify({ ...app, env: { ...app.env, CERT: "$server-cert.cert_file" } });
		expect(() => planTls(source, options("off"))).toThrow(/references inactive certificate/);
	});

	it("checks named certificate properties referenced from ordinary environment variables", () => {
		const app = document();
		const source = stringify({ ...app, env: { ...app.env, CERT: "$server-cert.cert_fil" } });
		expect(() => planTls(source, options())).toThrow(/unknown certificate property cert_fil/);
	});
});

describe("endpoint and component scope", () => {
	function multi() {
		const app = document();
		return { name: "multi", components: {
			api: { image: "api", provides: [{ name: "web", protocol: "http", port: 8080, exposed: true }] },
			gitea: { ...app, env: { PROTOCOL: "http" } },
		} };
	}

	it("requires qualification when a selector is ambiguous", () => {
		const source = stringify(multi());
		expect(() => planTls(source, options())).toThrow(/not unambiguous/);
		expect(() => planTls(source, options("native", { endpoint: "web" }))).toThrow(/ambiguous/);
		const plan = planTls(source, options("native", { endpoint: "gitea.web" }));
		expect(plan.component).toBe("gitea");
		expect(plan.launch.components.api!.provides![0]!.protocol).toBe("http");
	});

	it("refuses unknown and unexposed endpoints", () => {
		const app = document(); app.provides[0]!.exposed = false;
		expect(() => planTls(stringify(document()), options("native", { endpoint: "nope" }))).toThrow(/does not exist/);
		expect(() => planTls(stringify(app), options("native", { endpoint: "web" }))).toThrow(/must be exposed/);
	});

	it("does not repurpose $app for a selected secondary endpoint", () => {
		const app = multi();
		const source = stringify({ ...app, components: { ...app.components, gitea: document() } });
		expect(() => planTls(source, options("native", { endpoint: "gitea.web" }))).toThrow(/primary \$app publication context/);
	});

	it("refuses native activation when two endpoints share one certificate", () => {
		const app = document();
		app.provides.push({ name: "admin", protocol: "http", port: 3001, exposed: false, tls: "server-cert" });
		expect(() => planTls(stringify(app), options())).toThrow(/shared by multiple endpoints/);
		expect(() => planTls(stringify(app), options("off"))).toThrow(/shared by multiple endpoints/);
	});

	it("refuses cross-component collisions in the provider's global resource map", () => {
		const app = multi();
		const source = stringify({ ...app, components: { ...app.components,
			api: { ...app.components.api, requires: [{ name: "server-cert", type: "postgres" }] },
		} });
		expect(() => planTls(source, options("native", { endpoint: "gitea.web" }))).toThrow(/collides with another resource/);
	});

	it("does not lose an aliased TLS declaration while sanitizing another component", () => {
		const source = `name: aliases\ncomponents:\n  first: &app\n    image: gitea/gitea:latest\n    provides:\n      - name: web\n        protocol: http\n        port: 3000\n        exposed: true\n        tls: server-cert\n    supports:\n      - name: server-cert\n        type: certificate\n  second: *app\n`;
		expect(() => planTls(source, options("native", { endpoint: "second.web" }))).toThrow(/shared by multiple endpoints/);
	});

	it.each(["native", "passthrough", "reencrypt"] as const)("rejects canonical Docker sibling HTTP URL wiring in %s mode", (mode) => {
		for (const reference of ["$components.backend.url", "$components.backend.web.url",
			"origin=${components.backend.url}", "${components.backend.web.url:-https://fallback.example.test}",
			"${components.backend.url|base64}"]) {
			const source = stringify({ name: "siblings", components: {
				backend: document(), worker: { image: "alpine", env: { ORIGIN: reference } },
			} });
			expect(() => planTls(source, options(mode))).toThrow(/canonical Docker sibling URL transport is not supported/);
		}
	});

	it("also checks sibling URL references in dependency set_env", () => {
		const source = stringify({ name: "siblings", components: {
			backend: document(), worker: { image: "alpine", requires: [
				{ type: "redis", set_env: { ORIGIN: "$components.backend.web.url" } },
			] },
		} });
		expect(() => planTls(source, options())).toThrow(/worker.set_env.ORIGIN.*canonical Docker sibling URL transport/);
	});

	it.each(["off", "edge"] as const)("preserves sibling URL references when %s leaves the app on HTTP", (mode) => {
		const reference = "$components.backend.web.url";
		const source = stringify({ name: "siblings", components: {
			backend: document(), worker: { image: "alpine", env: { ORIGIN: reference }, requires: [
				{ type: "redis", set_env: { CALLBACK: "$components.backend.url" } },
			] },
		} });
		const plan = planTls(source, options(mode));
		expect(plan.launch.components.worker!.env!.ORIGIN!.default).toBe(reference);
		expect(plan.launch.components.worker!.requires![0]!.set_env!.CALLBACK).toBe("$components.backend.url");
	});

	it("preserves unrelated sibling references and escaped dollar literals in native mode", () => {
		const env = {
			OTHER: "$components.worker.url", HOST: "$components.backend.host", PORT: "$components.backend.port",
			LITERAL: "$$components.backend.url",
		};
		const source = stringify({ name: "siblings", components: {
			backend: document(), worker: { image: "alpine", env, provides: [{ protocol: "http", port: 8080 }] },
		} });
		const plan = planTls(source, options());
		expect(plan.launch.components.worker!.env).toEqual(Object.fromEntries(
			Object.entries(env).map(([key, value]) => [key, { default: value }]),
		));
	});
});
