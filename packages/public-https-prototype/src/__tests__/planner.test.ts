import { describe, expect, it } from "vitest";
import { readLaunch } from "@launchfile/sdk";
import { planPublicHttps, publicationOrigin } from "../planner.js";

const base = `name: test
image: example/app:demo
provides:
  - { name: web, protocol: http, port: 3000, exposed: true }
`;
const requirement = "requires:\n  - public: { endpoint: web, scheme: https }\n";
const url = { publicUrl: "https://app.example" };

describe("public HTTPS requirement preprocessing", () => {
  it("leaves an HTTP listener unchanged and cannot verify an HTTPS string", () => {
    const plan = planPublicHttps(base + requirement, url);
    expect(plan.status).toBe("unresolved");
    expect(plan.requirements).toEqual([{ component: "default", endpoint: "web", scheme: "https", url: "https://app.example", status: "unresolved" }]);
    expect(plan.launch.components.default?.provides?.[0]?.protocol).toBe("http");
    expect(plan.launch.components.default?.requires).toEqual([]);
  });

  it("preserves ordinary normalization", () => {
    const ordinary = base + "requires: [postgres]\nsupports: [redis]\n";
    expect(planPublicHttps(ordinary)).toEqual({ launch: readLaunch(ordinary), requirements: [], status: "no-public-https-requirement" });
  });

  it("validates before the legacy schema strips a mixed-kind marker", () => {
    const mixed = base + "requires:\n  - { type: postgres, public: { endpoint: web, scheme: https } }\n";
    expect(readLaunch(mixed).components.default?.requires?.[0]?.type).toBe("postgres");
    expect(() => planPublicHttps(mixed, url)).toThrow("Unknown requirement field");
  });

  it.each([
    "public: true",
    "public: {}",
    "public: { endpoint: web }",
    "public: { scheme: https }",
    "public: { endpoint: web, scheme: http }",
    "public: { endpoint: web, scheme: wss }",
    "public: { endpoint: web, scheme: https, required: false }",
    "public: { endpoint: frontend.web, scheme: https }",
    "public: { endpoint: '', scheme: https }",
    "public: { endpoint: 3000, scheme: https }",
  ])("rejects malformed requirements: %s", (entry) => {
    expect(() => planPublicHttps(base + `requires:\n  - ${entry}\n`, url)).toThrow();
  });

  it.each([
    "supports:\n  - public: { endpoint: web, scheme: https }",
    "requires: [public]",
    "supports: [public]",
    "requires: { public: { endpoint: web, scheme: https } }",
    "public: { endpoint: web, scheme: https }",
    "variants: {}",
    "tls: true",
  ])("rejects unsupported placements: %s", (entry) => {
    expect(() => planPublicHttps(base + entry, url)).toThrow();
  });

  it("rejects duplicates", () => {
    expect(() => planPublicHttps(base + requirement + "  - public: { endpoint: web, scheme: https }", url)).toThrow("Duplicate");
  });

  it.each([
    [base.replace("name: web", "name: api"), "exactly one"],
    [base.replace(", exposed: true", ""), "explicitly exposed"],
    [base.replace("protocol: http", "protocol: tcp"), "HTTP(S)"],
    [base + "  - { name: web, protocol: http, port: 3001, exposed: true }\n", "exactly one"],
    [base.replace("provides:\n", "provides:\n  - { name: first, protocol: tcp, port: 8080, exposed: true }\n"), "primary"],
  ])("refuses a wrong, ambiguous, private, non-HTTP, or secondary endpoint", (file, error) => {
    expect(() => planPublicHttps(file + requirement, url)).toThrow(error);
  });

  it("does not reuse primary publication context for a different component", () => {
    const file = `name: multi
components:
  frontend:
    provides: [{ name: web, protocol: http, port: 3000, exposed: true }]
  backend:
    provides: [{ name: web, protocol: http, port: 3001, exposed: true }]
    requires: [{ public: { endpoint: web, scheme: https } }]
`;
    expect(() => planPublicHttps(file, url)).toThrow("primary");
  });

  it("does not resolve a missing local endpoint against another component", () => {
    const file = `name: multi
components:
  frontend:
    provides: [{ name: web, protocol: http, port: 3000, exposed: true }]
  backend:
    requires: [{ public: { endpoint: web, scheme: https } }]
`;
    expect(() => planPublicHttps(file, url)).toThrow("exactly one");
  });

  it("accepts a requirement on the primary component", () => {
    const file = `name: multi
components:
  frontend:
    provides: [{ name: web, protocol: http, port: 3000, exposed: true }]
    requires: [{ public: { endpoint: web, scheme: https } }]
  backend:
    image: example/backend:demo
`;
    expect(planPublicHttps(file, url).requirements[0]?.component).toBe("frontend");
  });

  it("refuses ignored top-level requirements in multi-component files", () => {
    expect(() => planPublicHttps(base + requirement + "components:\n  frontend: { image: example/app:demo }\n", url)).toThrow("not inherited");
  });

  it("does not mutate YAML aliases while preprocessing", () => {
    const file = `name: aliases
components:
  first: &app
    provides: [{ name: web, protocol: http, port: 3000, exposed: true }]
    requires: [{ public: { endpoint: web, scheme: https } }]
  second: *app
`;
    expect(() => planPublicHttps(file, url)).toThrow("primary");
  });

  it("also permits an already declared HTTPS listener without native TLS syntax", () => {
    expect(planPublicHttps(base.replace("protocol: http", "protocol: https") + requirement, url).status).toBe("unresolved");
  });

  it("does not accept native TLS capability silently", () => {
    expect(() => planPublicHttps(base.replace("protocol: http", "tls: server-cert, protocol: http") + requirement, url)).toThrow("separate");
  });

  it.each([undefined, "http://app.example", "ftp://app.example", "https:app.example", "https:///", "https:///app.example", "https://@app.example", "https://user:secret@app.example", "https://app.example/path", "https://app.example?x=y", "https://app.example?", "https://app.example#fragment", "https://app.example#", "https://app.example\\bad", "https://app.example\n"]) (
    "requires a supplied HTTPS origin: %s", (publicUrl) => {
      expect(() => planPublicHttps(base + requirement, { publicUrl })).toThrow();
    },
  );

  it("normalizes a valid origin", () => {
    expect(publicationOrigin("HTTPS://App.Example:443/")).toBe("https://app.example");
  });
});
