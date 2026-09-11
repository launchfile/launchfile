import { readFile } from "node:fs/promises";
import { readLaunch, resolveExpression } from "@launchfile/sdk";
import { parse, stringify } from "yaml";
import { describe, expect, test } from "vitest";
import { planTls, type TlsMode } from "../planner.js";

const certificate = { certFile: "/run/tls/server.pem", keyFile: "/run/tls/server-key.pem", caFile: "/run/tls/probe-ca.pem" };
const cases = [
  ["gitea", "GITEA__server__HTTP_PORT", "GITEA__server__CERT_FILE", "GITEA__server__KEY_FILE"],
  ["grafana", "GF_SERVER_HTTP_PORT", "GF_SERVER_CERT_FILE", "GF_SERVER_CERT_KEY"],
  ["miniflux", "PORT", "CERT_FILE", "KEY_FILE"],
  ["vaultwarden", "ROCKET_PORT", "ROCKET_TLS", "ROCKET_TLS"],
] as const;

describe.each(cases)("source-backed catalog candidate: %s", (app, portKey, certKey, keyKey) => {
  const source = () => readFile(new URL(`../../examples/catalog/${app}/Launchfile`, import.meta.url), "utf8");
  test("preserves the shipped database, storage, identity, and listener baseline", async () => {
    const shipped = readLaunch(await readFile(new URL(`../../../../catalog/apps/${app}/Launchfile`, import.meta.url), "utf8"));
    const baseline = planTls(await source(), { mode: "off", publicUrl: "http://example.test" }).launch;
    expect(baseline.name).toBe(shipped.name);
    for (const field of ["image", "provides", "requires", "storage", "health", "restart"] as const) {
      expect(baseline.components.default![field]).toEqual(shipped.components.default![field]);
    }
    expect(baseline.components.default!.env).toMatchObject(shipped.components.default!.env ?? {});
  });
  test("plans all five arrangements without mistaking source evidence for a live deployment", async () => {
    for (const mode of ["off", "edge", "native", "passthrough", "reencrypt"] as TlsMode[]) {
      const plan = planTls(await source(), { mode, publicUrl: `${mode === "off" ? "http" : "https"}://example.test`, certificates: { "server-cert": certificate } });
      const native = ["native", "passthrough", "reencrypt"].includes(mode);
      expect(plan.protocol).toBe(native ? "https" : "http");
      expect(plan.certificate).toBe(native ? "server-cert" : undefined);
    }
  });
  test("coordinates an explicit native port with documented app settings and container certificate paths", async () => {
    const raw = parse(await source());
    raw.provides.find((entry: any) => entry.tls).tls = { certificate: "server-cert", port: 3443 };
    const plan = planTls(stringify(raw), { mode: "native", publicUrl: "https://example.test", certificates: { "server-cert": certificate } });
    const binding = plan.launch.components.default!.supports!.find((entry) => entry.name === "server-cert")!;
    const env = Object.fromEntries(Object.entries(binding.set_env!).map(([key, value]) =>
      [key, resolveExpression(value, { resource: plan.resources["server-cert"]!.properties })]));
    expect(env[portKey]).toBe("3443");
    expect(env[certKey]).toContain(certificate.certFile);
    expect(env[keyKey]).toContain(certificate.keyFile);
    expect(plan.port).toBe(3443);
  });
});
