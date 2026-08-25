import { describe, expect, it } from "vitest";
import { unsuppliedRequiredEnv } from "../env.js";
import { readLaunch } from "../reader.js";

const component = (yaml: string) => {
	const launch = readLaunch(yaml);
	return launch.components.default!;
};

describe("unsuppliedRequiredEnv (D-52, PROVIDERS.md §10 rule 8)", () => {
	const mixed = component(`
name: app
image: acme/app:1
env:
  API_KEY:
    required: true
    sensitive: true
  SITE_URL:
    required: true
  HAS_DEFAULT:
    required: true
    default: fine
  GENERATED:
    required: true
    generator: secret
  OPTIONAL:
    description: "not required"
`);

	it("lists a required var with no default, generator, or arrived binding", () => {
		const keys = unsuppliedRequiredEnv(mixed, []).map((v) => v.key);
		expect(keys).toEqual(["API_KEY", "SITE_URL"]);
	});

	it("distinguishes sensitive vars", () => {
		const found = unsuppliedRequiredEnv(mixed, []);
		expect(found.find((v) => v.key === "API_KEY")?.sensitive).toBe(true);
		expect(found.find((v) => v.key === "SITE_URL")?.sensitive).toBe(false);
	});

	it("treats default: and generator: as the file supplying the value", () => {
		const keys = unsuppliedRequiredEnv(mixed, []).map((v) => v.key);
		expect(keys).not.toContain("HAS_DEFAULT");
		expect(keys).not.toContain("GENERATED");
	});

	it("never lists a var that is not required", () => {
		expect(unsuppliedRequiredEnv(mixed, []).map((v) => v.key)).not.toContain("OPTIONAL");
	});

	it("counts a key the caller says arrived as supplied", () => {
		const keys = unsuppliedRequiredEnv(mixed, ["SITE_URL"]).map((v) => v.key);
		expect(keys).toEqual(["API_KEY"]);
	});

	it("tests arrival, not declaration — a declared binding that did not inject stays unsupplied", () => {
		// The caller passes the keys that really arrived. A `supports:` binding on
		// an unprovisioned resource contributes none, so its key is still listed.
		const withBinding = component(`
name: app
image: acme/app:1
supports:
  - type: redis
    set_env:
      CACHE_URL: $url
env:
  CACHE_URL:
    required: true
`);
		expect(unsuppliedRequiredEnv(withBinding, []).map((v) => v.key)).toEqual(["CACHE_URL"]);
		expect(unsuppliedRequiredEnv(withBinding, ["CACHE_URL"])).toEqual([]);
	});

	it("counts an empty arrived value as supplied (D-52 Scope leaves that to L-4)", () => {
		const empty = component(`
name: app
image: acme/app:1
env:
  MAYBE_EMPTY:
    required: true
    default: $components.nope.url
`);
		expect(unsuppliedRequiredEnv(empty, [])).toEqual([]);
	});

	it("returns nothing for a component with no env block", () => {
		expect(unsuppliedRequiredEnv({}, [])).toEqual([]);
	});
});
