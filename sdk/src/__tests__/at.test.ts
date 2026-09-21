import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AT_APP_HOST, atDeclarations, atEntryLabel } from "../at.js";
import { lintLaunch } from "../lint.js";
import { readLaunch, validateLaunch } from "../reader.js";
import { LaunchSchema } from "../schema.js";
import { writeLaunch } from "../writer.js";

/**
 * D-next: a published HTTP-family `provides` entry may declare `at:`, the
 * names it answers at relative to the app host.
 */

/** One listener that answers at the app host, three labels and both patterns. */
function app(at: unknown, extra: Record<string, unknown> = {}) {
	return {
		version: "launch/v1",
		name: "portal",
		image: "example/portal:1",
		provides: [
			{
				name: "https",
				protocol: "https",
				port: 443,
				exposed: true,
				...(at !== undefined ? { at } : {}),
				...extra,
			} as Record<string, unknown>,
		],
	};
}

/** Every issue message the schema produced, joined for substring assertions. */
function errorsFor(input: unknown): string {
	const result = LaunchSchema.safeParse(input);
	expect(result.success).toBe(false);
	return result.error!.issues.map((i) => i.message).join("\n");
}

describe("`at:` accepts a string or a list (rule 1)", () => {
	it("accepts the string shorthand", () => {
		expect(LaunchSchema.safeParse(app("dash")).success).toBe(true);
	});

	it("accepts every kind of value in one list", () => {
		const input = app(["@", "dash", "auth", "*", "*.*"]);
		expect(LaunchSchema.safeParse(input).success).toBe(true);
	});

	it("parses `at: dash` and `at: [dash]` to the same model", () => {
		const fromString = validateLaunch(app("dash"));
		const fromList = validateLaunch(app(["dash"]));
		expect(fromString).toEqual(fromList);
		expect(fromString.components.default!.provides![0]!.at).toEqual(["dash"]);
	});

	it("leaves an entry without `at:` untouched", () => {
		const launch = validateLaunch(app(undefined));
		expect(launch.components.default!.provides![0]).not.toHaveProperty("at");
	});

	it("rejects an empty list", () => {
		expect(LaunchSchema.safeParse(app([])).success).toBe(false);
	});
});

describe("`at:` value grammar (rule 2)", () => {
	it.each([
		["a label that starts with a digit", "1up"],
		["a 63-character label", "a".repeat(63)],
		["a one-character label", "a"],
	])("accepts %s", (_, value) => {
		expect(LaunchSchema.safeParse(app(value)).success).toBe(true);
	});

	it.each([
		["a trailing hyphen", "dash-"],
		["a leading hyphen", "-dash"],
		["`--` in the third and fourth characters", "ab--c"],
		["a pattern with a label suffix", "*.dash"],
		["a pattern with a label prefix", "dash.*"],
		["a pattern three levels deep", "*.*.*"],
		["a dotted label", "admin.internal"],
		["an uppercase label", "DASH"],
		["a 64-character label", "a".repeat(64)],
		["an empty string", ""],
	])("rejects %s", (_, value) => {
		expect(LaunchSchema.safeParse(app(value)).success).toBe(false);
	});

	it("names the accepted forms when it rejects a value", () => {
		expect(errorsFor(app("DASH"))).toContain("lowercase DNS label");
	});
});

describe("`at:` cross-entry rules (rule 4)", () => {
	it("rejects `at:` on an entry that is not exposed", () => {
		expect(errorsFor(app("dash", { exposed: false }))).toContain(
			"is not `exposed: true`",
		);
	});

	it("rejects `at:` on an entry with no `exposed` key", () => {
		const input = app("dash");
		delete (input.provides[0] as Record<string, unknown>).exposed;
		expect(errorsFor(input)).toContain("is not `exposed: true`");
	});

	it.each(["tcp", "udp"])(
		"rejects `at:` on a %s listener, naming the protocol",
		(protocol) => {
			const message = errorsFor(app("dash", { protocol }));
			expect(message).toContain(`\`protocol: ${protocol}\``);
			expect(message).toContain('"https"');
		},
	);

	it.each(["http", "https", "ws", "grpc"])(
		"accepts `at:` on a %s listener",
		(protocol) => {
			expect(LaunchSchema.safeParse(app("dash", { protocol })).success).toBe(
				true,
			);
		},
	);

	it("rejects a value listed twice on one entry", () => {
		expect(errorsFor(app(["dash", "dash"]))).toContain('lists "dash" twice');
	});

	it("rejects a value declared by two entries on one component, naming both", () => {
		const input = app("dash");
		input.provides.push({
			name: "api",
			protocol: "http",
			port: 8080,
			exposed: true,
			at: ["api", "dash"],
		});
		const message = errorsFor(input);
		expect(message).toContain('"https" on (top-level)');
		expect(message).toContain('"api" on (top-level)');
	});

	it("rejects a pattern declared on two components, naming both", () => {
		const input = {
			version: "launch/v1",
			name: "portal",
			components: {
				web: {
					image: "example/web:1",
					provides: [
						{ name: "web", protocol: "http", port: 80, exposed: true, at: "*" },
					],
				},
				tenants: {
					image: "example/tenants:1",
					provides: [{ protocol: "http", port: 81, exposed: true, at: ["*"] }],
				},
			},
		};
		const message = errorsFor(input);
		expect(message).toContain('"web" on web');
		expect(message).toContain("#1 (unnamed) on tenants");
	});

	it("accepts a label and a pattern of the same depth on different entries", () => {
		const input = app(["@", "dash"]);
		input.provides.push({
			name: "tenants",
			protocol: "http",
			port: 8080,
			exposed: true,
			at: "*",
		});
		expect(LaunchSchema.safeParse(input).success).toBe(true);
	});
});

describe("the primary endpoint holds the app host without declaring it (rule 4)", () => {
	/** A primary endpoint `web` plus a second published entry. */
	function withPrimary(primaryAt: unknown, otherAt: unknown) {
		return {
			version: "launch/v1",
			name: "portal",
			image: "example/portal:1",
			provides: [
				{
					name: "web",
					protocol: "http",
					port: 80,
					exposed: true,
					...(primaryAt !== undefined ? { at: primaryAt } : {}),
				},
				{
					name: "landing",
					protocol: "http",
					port: 81,
					exposed: true,
					at: otherAt,
				},
			],
			requires: [{ type: "https-origin", endpoint: "web" }],
		};
	}

	it('rejects a second entry that declares "@" beside a primary with no `at:`', () => {
		const message = errorsFor(withPrimary(undefined, "@"));
		expect(message).toContain("primary endpoint (D-60 rule 3)");
		expect(message).toContain('"landing" on (top-level)');
	});

	it('accepts "@" on a second entry when the primary declares `at:` without it', () => {
		expect(LaunchSchema.safeParse(withPrimary("dash", "@")).success).toBe(true);
	});

	it("accepts a second entry with a label beside a primary with no `at:`", () => {
		expect(
			LaunchSchema.safeParse(withPrimary(undefined, "landing")).success,
		).toBe(true);
	});

	it('warns when the primary declares `at:` without "@"', () => {
		const warnings = lintLaunch(validateLaunch(withPrimary("dash", "@")));
		expect(warnings.filter((w) => w.includes('without "@"'))).toHaveLength(1);
		expect(warnings.join("\n")).toContain('primary endpoint "web"');
	});

	it('does not warn when the primary declares "@"', () => {
		const warnings = lintLaunch(
			validateLaunch(withPrimary(["@", "dash"], "landing")),
		);
		expect(warnings.join("\n")).not.toContain('without "@"');
	});

	it("does not warn when the primary declares no `at:`", () => {
		const warnings = lintLaunch(
			validateLaunch(withPrimary(undefined, "landing")),
		);
		expect(warnings.join("\n")).not.toContain('without "@"');
	});
});

describe("`at:` round-trips through the writer", () => {
	it("writes a one-name list as the string shorthand", () => {
		const yaml = writeLaunch(validateLaunch(app(["dash"])));
		expect(yaml).toContain("at: dash");
		expect(readLaunch(yaml)).toEqual(validateLaunch(app("dash")));
	});

	it("writes a longer list as a list and reads it back unchanged", () => {
		const launch = validateLaunch(app(["@", "dash", "*", "*.*"]));
		expect(readLaunch(writeLaunch(launch))).toEqual(launch);
	});

	it("writes no `at:` key for an entry that declares none", () => {
		expect(writeLaunch(validateLaunch(app(undefined)))).not.toContain("at:");
	});
});

describe("atDeclarations", () => {
	it("lists every entry that declares `at:`, with its component and values", () => {
		const launch = validateLaunch({
			version: "launch/v1",
			name: "portal",
			components: {
				web: {
					image: "example/web:1",
					provides: [
						{ name: "metrics", protocol: "http", port: 9090 },
						{
							name: "web",
							protocol: "http",
							port: 80,
							exposed: true,
							at: [AT_APP_HOST, "dash"],
						},
					],
				},
				tenants: {
					image: "example/tenants:1",
					provides: [{ protocol: "http", port: 81, exposed: true, at: "*" }],
				},
			},
		});
		const declarations = atDeclarations(launch);
		expect(declarations).toEqual([
			{ component: "web", index: 1, name: "web", values: ["@", "dash"] },
			{ component: "tenants", index: 0, values: ["*"] },
		]);
		expect(declarations.map(atEntryLabel)).toEqual([
			'`provides` entry "web" on web',
			"`provides` entry #1 (unnamed) on tenants",
		]);
	});

	it("is empty for a Launchfile that declares no `at:`", () => {
		expect(atDeclarations(validateLaunch(app(undefined)))).toEqual([]);
	});
});

describe("the published JSON Schema and the SDK accept the same `at:` values", () => {
	const schemaPath = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"..",
		"spec",
		"schema",
		"launchfile.schema.json",
	);
	const schemaText = readFileSync(schemaPath, "utf-8");
	const atValue = JSON.parse(schemaText).$defs.atValue as {
		pattern: string;
		not: { pattern: string };
	};
	const schemaAccepts = (value: string) =>
		new RegExp(atValue.pattern).test(value) &&
		!new RegExp(atValue.not.pattern).test(value);

	it.each([
		"@",
		"*",
		"*.*",
		"dash",
		"a-b",
		"a--b",
		"1up",
		"a".repeat(63),
		"ab--cd",
		"ab--",
		"dash-",
		"-dash",
		"DASH",
		"*.dash",
		"*.*.*",
		"admin.internal",
		"a".repeat(64),
		"",
	])("agree on %j", (value) => {
		expect(schemaAccepts(value)).toBe(
			LaunchSchema.safeParse(app(value)).success,
		);
	});

	it("uses no regex lookaround, which RE2-based validators cannot compile", () => {
		expect(schemaText).not.toContain("(?");
	});
});
