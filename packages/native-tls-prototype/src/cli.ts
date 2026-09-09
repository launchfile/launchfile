import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { compileDockerTls } from "./docker.js";
import { planTls, type CertificateInput, type TlsMode } from "./planner.js";

const help = `Experimental Launchfile native TLS planner (RFC #445)

bun run plan <Launchfile> --tls=<mode> --url=<public URL>

Modes: off, edge, native, passthrough, reencrypt

  --endpoint <name>       Select a named endpoint (component.name if needed)
  --cert <path>           PEM server certificate
  --key <path>            PEM private key
  --ca <path>             PEM issuing root CA (prototype: no intermediates)
  --resource <name>       Certificate resource name (default server-cert)
  --host-port <port>      Loopback host port for Compose output (default 33000)
  --compose-file <path>   Write an isolated Compose file; validates certificates
  --json                 Machine-readable plan summary

This planner does not start containers or configure public routing.
Run bun run prove for the isolated real-Gitea proof and automatic teardown.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2), allowPositionals: true, strict: true,
    options: {
      tls: { type: "string", default: "off" },
      url: { type: "string", default: "http://localhost:33000" },
      endpoint: { type: "string" },
      cert: { type: "string" }, key: { type: "string" }, ca: { type: "string" },
      resource: { type: "string", default: "server-cert" },
      "host-port": { type: "string", default: "33000" },
      "compose-file": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) { console.log(help); return; }
  if (positionals.length !== 1) throw new Error("Supply one Launchfile path. Use --help for examples.");
  const modes: TlsMode[] = ["off", "edge", "native", "passthrough", "reencrypt"];
  if (!modes.includes(values.tls as TlsMode)) throw new Error(`Unsupported TLS mode: ${values.tls}`);
  const suppliedPaths = [values.cert, values.key, values.ca].filter(Boolean);
  if (suppliedPaths.length !== 0 && suppliedPaths.length !== 3) throw new Error("Supply --cert, --key, and --ca together");
  const certificates: Record<string, CertificateInput> = {};
  if (values.cert && values.key && values.ca) {
    certificates[values.resource] = { certFile: resolve(values.cert), keyFile: resolve(values.key), caFile: resolve(values.ca) };
  }
  const source = await readFile(resolve(positionals[0]!), "utf8");
  const options = {
    mode: values.tls as TlsMode, publicUrl: values.url,
    endpoint: values.endpoint, certificates,
  };
  const compiled = values["compose-file"]
    ? await compileDockerTls(source, { ...options, hostPort: Number(values["host-port"]), projectName: "launchfile-tls-preview" })
    : undefined;
  const plan = compiled?.plan ?? planTls(source, options);
  const summary = {
    experimental: true,
    mode: plan.mode,
    publicUrl: plan.publicUrl,
    endpoint: `${plan.component}.${plan.endpoint}`,
    listener: `${plan.protocol}:${plan.port}`,
    certificate: plan.certificate ?? null,
    warnings: compiled?.warnings ?? plan.warnings,
    status: compiled ? "compiled; deployment not executed" : "planned; material and routing not verified",
  };
  if (compiled && values["compose-file"]) {
    await writeFile(resolve(values["compose-file"]), compiled.compose, { mode: 0o600, flag: "wx" });
  }
  if (values.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`Experimental plan: ${summary.mode}`);
    console.log(`  Public URL:  ${summary.publicUrl}`);
    console.log(`  Endpoint:    ${summary.endpoint}`);
    console.log(`  App listens: ${summary.listener}`);
    console.log(`  Certificate: ${summary.certificate ?? "not activated"}`);
    for (const warning of summary.warnings) console.log(`  Gap: ${warning}`);
    console.log(`  ${summary.status}`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "TLS planning failed");
  process.exitCode = 1;
});
