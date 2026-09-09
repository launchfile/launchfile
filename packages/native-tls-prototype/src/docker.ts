import { launchToCompose, redactSecrets } from "@launchfile/docker";
import { parse, stringify } from "yaml";
import { planTls, type CertificateInput, type TlsMode, type TlsPlan } from "./planner.js";
import { registerBindingProperties } from "./redaction.js";

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

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
// Replacement strings interpret $$ themselves; a callback preserves both dollars for Compose.
const composeLiteral = (value: string): string => value.replaceAll("$", () => "$$");

/** Compile proposed syntax to the existing provider, then attach supplied paths and a TLS-aware app health check, without reading certificate bytes. */
export async function compileDockerTls(yaml: string, options: DockerTlsOptions): Promise<DockerTlsResult> {
  // Register supplied values before the provider can emit anything. Even if a
  // future registry knows key_file, the explicit credential rule still wins.
  for (const input of Object.values(options.certificates ?? {})) {
    registerBindingProperties({ cert_file: input.certFile, key_file: input.keyFile, ca_file: input.caFile },
      ["cert_file", "key_file", "ca_file"]);
  }
  try { return await compileSuppliedPaths(yaml, options); }
  catch (error) { throw new Error(redactSecrets(error instanceof Error ? error.message : "TLS compilation failed")); }
}

async function compileSuppliedPaths(yaml: string, options: DockerTlsOptions): Promise<DockerTlsResult> {
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
  for (const resource of Object.values(plan.resources)) {
    registerBindingProperties(resource.properties, ["cert_file", "key_file", "ca_file"]);
  }
  const serverName = options.serverName ?? new URL(plan.publicUrl).hostname;
  if (plan.certificate) {
    const certificate = options.certificates?.[plan.certificate];
    if (!certificate) throw new Error(`Missing certificate material for ${plan.certificate}`);
    // Contents, existence, and readiness are the supplying consumer’s responsibility (D-56).
    for (const key of ["certFile", "keyFile", "caFile"] as const) {
      const path = certificate[key];
      if (typeof path !== "string" || !path.startsWith("/") || path.endsWith("/") || /[\u0000-\u001f\u007f]/.test(path) ||
          path.split("/").some(part => part === "." || part === "..")) {
        throw new Error(`Certificate binding ${plan.certificate}.${key} requires an absolute file path without traversal`);
      }
    }
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
  const warnings = [...plan.warnings, ...generated.warnings].map(redactSecrets);
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
