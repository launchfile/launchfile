import { mkdtemp, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { compileDockerTls, validateCertificate } from "../docker.js";
import { createCertificates } from "../../scripts/certificates.js";

const fixture = await readFile(new URL("../../examples/gitea/Launchfile", import.meta.url), "utf8");

describe("existing Docker provider integration", () => {
  test("edge publication keeps HTTP inside and supplies the public HTTPS ROOT_URL", async () => {
    const result = await compileDockerTls(fixture, {
      mode: "edge", publicUrl: "https://localhost:34000", hostPort: 34001, projectName: "tls-edge-test",
    });
    const compose = parse(result.compose);
    const app = compose.services[result.service];
    expect(app.environment.GITEA__server__PROTOCOL).toBe("http");
    expect(app.environment.GITEA__server__ROOT_URL).toBe("https://localhost:34000");
    expect(app.environment.GITEA__server__CERT_FILE).toBeUndefined();
    expect(app.ports).toEqual(["127.0.0.1:34001:3000"]);
    expect(app.healthcheck.test[1]).toContain("http://127.0.0.1:3000/api/healthz");
    expect(app.healthcheck.test[1]).toContain("curl --disable --noproxy '*'");
    expect(app.volumes.every((volume: unknown) => typeof volume === "string")).toBe(true);
  });

  test("supplied certificate availability does not activate HTTP app TLS or read unused files", async () => {
    const result = await compileDockerTls(fixture, {
      mode: "off", publicUrl: "http://localhost:34000", hostPort: 34000, projectName: "tls-off-test",
      certificates: { "server-cert": { certFile: "/nonexistent/cert", keyFile: "/nonexistent/key", caFile: "/nonexistent/ca" } },
    });
    expect(result.plan.protocol).toBe("http");
    expect(result.plan.resources).toEqual({});
  });

  test("native mode refuses nonexistent material before generating artifacts", async () => {
    await expect(compileDockerTls(fixture, {
      mode: "native", publicUrl: "https://localhost:34000", hostPort: 34000, projectName: "tls-native-test",
      certificates: { "server-cert": { certFile: "/nonexistent/cert", keyFile: "/nonexistent/key", caFile: "/nonexistent/ca" } },
    })).rejects.toThrow();
  });

  test("preserves provider warnings without adding an operator strictness policy", async () => {
    const scheduled = `${fixture}\nschedule: '0 * * * *'\n`;
    const opts = { mode: "off" as const, publicUrl: "http://localhost:34000", hostPort: 34000, projectName: "tls-strict-test" };
    expect((await compileDockerTls(scheduled, opts)).warnings.join(" ")).toContain("schedule");
  });

  test("does not emit a partial app when a sibling's mandatory host capability is refused", async () => {
    const source = `name: partial\ncomponents:\n  web:\n    image: nginx\n    provides:\n      - name: web\n        protocol: http\n        port: 80\n        exposed: true\n  worker:\n    image: alpine\n    requires:\n      - host: { network: host }\n`;
    await expect(compileDockerTls(source, {
      mode: "off", publicUrl: "http://localhost:34000", hostPort: 34000, projectName: "tls-required-host-test",
    })).rejects.toThrow(/cannot emit a partial application/);
  });

  test("retains the existing required-environment failure floor", async () => {
    const source = `name: required-env\nimage: nginx\nprovides:\n  - name: web\n    protocol: http\n    port: 80\n    exposed: true\nenv:\n  API_TOKEN: { required: true, sensitive: true }\n`;
    await expect(compileDockerTls(source, {
      mode: "off", publicUrl: "http://localhost:34000", hostPort: 34000, projectName: "tls-required-env-test",
    })).rejects.toThrow(/unsatisfied environment/);
  });
});

describe("certificate delivery and authenticated probes", () => {
  let directory: string;
  let certificates: Awaited<ReturnType<typeof createCertificates>>;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tls-prototype-$literal-"));
    certificates = await createCertificates(directory);
  }, 30_000);
  afterAll(async () => {
    if (!directory) return;
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  });

  test("native selection mounts read-only material, escapes Compose interpolation and authenticates probe", async () => {
    const result = await compileDockerTls(fixture, {
      mode: "native", publicUrl: "https://localhost:34000", hostPort: 34000, projectName: "tls-material-test",
      certificates: { "server-cert": certificates.backend },
    });
    const service = parse(result.compose).services[result.service];
    const mounts = service.volumes.filter((volume: unknown) => typeof volume === "object");
    expect(mounts).toHaveLength(3);
    expect(mounts.every((volume: { source: string; read_only: boolean }) => volume.source.includes("$$literal") && volume.read_only)).toBe(true);
    expect(service.environment.GITEA__server__PROTOCOL).toBe("https");
    expect(service.environment.GITEA__server__HTTP_PORT).toBe("3000");
    expect(service.healthcheck.test[1]).toContain("--cacert");
    expect(service.healthcheck.test[1]).toContain("--resolve 'localhost:3000:127.0.0.1'");
    expect(service.healthcheck.test[1]).toContain("https://localhost:3000/api/healthz");
    expect(service.healthcheck.test[1]).not.toMatch(/--insecure| -k /);
  });

  test("rejects certificate/private-key mismatch", async () => {
    await expect(validateCertificate({ ...certificates.backend, keyFile: certificates.edge.keyFile }, "localhost")).rejects.toThrow("Invalid certificate/private key pair");
  });
  test("rejects a leaf signed by a different CA", async () => {
    await expect(validateCertificate({ ...certificates.backend, caFile: certificates.wrongCaFile }, "localhost")).rejects.toThrow("not signed");
  });
  test("rejects a trusted certificate for the wrong hostname", async () => {
    await expect(validateCertificate(certificates.wrongHost, "localhost")).rejects.toThrow("does not authenticate");
  });
  test("rejects a correctly signed and named certificate restricted to TLS client use", async () => {
    await expect(validateCertificate(certificates.clientOnly, "localhost")).rejects.toThrow("TLS server certificate verification failed");
  });
});
