import { createPrivateKey, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { launchToCompose } from "@launchfile/docker";
import { parse, stringify } from "yaml";
import { planTls, type CertificateInput, type TlsMode, type TlsPlan } from "./planner.js";

const execute = promisify(execFile);

export interface DockerTlsOptions {
  mode: TlsMode;
  publicUrl: string;
  endpoint?: string;
  certificates?: Record<string, CertificateInput>;
  hostPort: number;
  projectName: string;
  serverName?: string;
}

export interface DockerTlsResult {
  plan: TlsPlan;
  compose: string;
  service: string;
  warnings: string[];
}

async function readMaterial(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Certificate material paths must be absolute");
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 1_048_576) {
    throw new Error("Certificate material must be a regular file smaller than 1 MiB");
  }
  return readFile(path, "utf8");
}

/** This prototype deliberately supports one root CA and one directly signed leaf. */
export async function validateCertificate(input: CertificateInput, serverName: string): Promise<void> {
  const [certPem, keyPem, caPem] = await Promise.all([
    readMaterial(input.certFile), readMaterial(input.keyFile), readMaterial(input.caFile),
  ]);
  if ((certPem.match(/BEGIN CERTIFICATE/g) ?? []).length !== 1 ||
      (caPem.match(/BEGIN CERTIFICATE/g) ?? []).length !== 1) {
    throw new Error("Prototype certificate validation supports one leaf and one root CA, without intermediates");
  }
  let leaf: X509Certificate;
  let ca: X509Certificate;
  try {
    leaf = new X509Certificate(certPem);
    ca = new X509Certificate(caPem);
    if (!leaf.checkPrivateKey(createPrivateKey(keyPem))) throw new Error("mismatch");
  } catch {
    throw new Error("Invalid certificate/private key pair");
  }
  const now = Date.now();
  for (const cert of [leaf, ca]) {
    if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now) {
      throw new Error("Certificate is expired or not yet valid");
    }
  }
  if (!ca.ca || !leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) {
    throw new Error("Certificate is not signed by the supplied trust root");
  }
  if (!(isIP(serverName) ? leaf.checkIP(serverName) : leaf.checkHost(serverName))) {
    throw new Error(`Certificate does not authenticate server name ${serverName}`);
  }
  // A valid signature and hostname do not authorize server use: a client-only
  // leaf can pass both. Delegate purpose/key-usage checks to the TLS verifier.
  try {
    await execute("openssl", ["verify", "-purpose", "sslserver", "-CAfile", input.caFile, input.certFile],
      { timeout: 10_000, maxBuffer: 64 * 1024 });
  } catch {
    throw new Error("TLS server certificate verification failed; check certificate purpose and OpenSSL availability");
  }
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
// Replacement strings interpret $$ themselves; a callback preserves both dollars for Compose.
const composeLiteral = (value: string): string => value.replaceAll("$", () => "$$");

/** Compile proposed syntax to the existing provider, then attach validated material and a TLS-aware probe. */
export async function compileDockerTls(yaml: string, options: DockerTlsOptions): Promise<DockerTlsResult> {
  if (!Number.isInteger(options.hostPort) || options.hostPort < 1 || options.hostPort > 65535) {
    throw new Error("hostPort must be an integer from 1 to 65535");
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(options.projectName)) throw new Error("Invalid isolated Docker project name");
  const containerInputs: Record<string, CertificateInput> = {};
  for (const name of Object.keys(options.certificates ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) throw new Error("Invalid certificate resource name");
    const directory = `/run/launchfile-certificates/${name}`;
    containerInputs[name] = { certFile: `${directory}/cert.pem`, keyFile: `${directory}/key.pem`, caFile: `${directory}/ca.pem` };
  }
  const plan = planTls(yaml, { ...options, certificates: containerInputs });
  const serverName = options.serverName ?? new URL(plan.publicUrl).hostname;
  if (plan.certificate) {
    const certificate = options.certificates?.[plan.certificate];
    if (!certificate) throw new Error(`Missing certificate material for ${plan.certificate}`);
    await validateCertificate(certificate, serverName);
  }

  const launch = structuredClone(plan.launch);
  // The demonstrator publishes only the endpoint it owns; unrelated host ports stay untouched.
  for (const [componentName, component] of Object.entries(launch.components)) {
    for (const endpoint of component.provides ?? []) {
      const selected = componentName === plan.component &&
        (endpoint.name === plan.endpoint || (!endpoint.name && String(endpoint.port) === plan.endpoint));
      endpoint.exposed = selected;
      if (selected) endpoint.bind = "127.0.0.1";
    }
  }
  const generated = launchToCompose(launch, {
    appUrl: plan.publicUrl,
    networkName: options.projectName,
    hostPorts: { [plan.component]: options.hostPort },
    resources: plan.resources,
  });
  if (generated.unsuppliedRequired.length || generated.unboundOperatorVolumes.length) {
    throw new Error("The app has unsatisfied environment or operator storage requirements");
  }
  if (Object.keys(launch.components).some((name) => !generated.services[name])) {
    throw new Error("The provider refused a component; this prototype cannot emit a partial application");
  }
  const warnings = [...plan.warnings, ...generated.warnings];
  const serviceName = generated.services[plan.component];
  if (!serviceName) throw new Error("The provider refused the selected component");
  const compose = parse(generated.yaml) as {
    services: Record<string, { volumes?: unknown[]; healthcheck?: Record<string, unknown>; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  const service = compose.services[serviceName];
  if (!service) throw new Error("Missing selected service in generated Compose");
  if (plan.certificate) {
    const host = options.certificates![plan.certificate]!;
    const container = containerInputs[plan.certificate]!;
    service.volumes ??= [];
    for (const key of ["certFile", "keyFile", "caFile"] as const) {
      service.volumes.push({ type: "bind", source: composeLiteral(host[key]), target: container[key], read_only: true });
    }
  }
  const health = launch.components[plan.component]!.health;
  if (health && !health.command) {
    const path = health.path ?? "/";
    if (!path.startsWith("/") || /[\r\n]/.test(path)) throw new Error("Health path must be an absolute path without line breaks");
    const host = plan.protocol === "https" ? serverName : "127.0.0.1";
    const url = `${plan.protocol}://${host}:${plan.port}${path}`;
    const certificate = plan.certificate ? containerInputs[plan.certificate] : undefined;
    const tlsArgs = certificate
      ? ` --cacert ${shellQuote(certificate.caFile)} --resolve ${shellQuote(`${serverName}:${plan.port}:127.0.0.1`)}`
      : "";
    service.healthcheck = {
      ...service.healthcheck,
      test: ["CMD-SHELL", composeLiteral(`curl --disable --noproxy '*' --fail --silent --show-error --max-time 5${tlsArgs} ${shellQuote(url)} > /dev/null`)],
    };
  }
  return { plan, compose: stringify(compose), service: serviceName, warnings };
}
