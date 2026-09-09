import { createPrivateKey, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { CertificateInput } from "./planner.js";

const execute = promisify(execFile);

async function readMaterial(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Certificate material paths must be absolute");
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 1_048_576) throw new Error("invalid file");
    return await readFile(path, "utf8");
  } catch {
    throw new Error("Cannot read certificate material: require regular files smaller than 1 MiB");
  }
}

/** Optional supplying-consumer preflight, never called by the provider compiler.
 * This proof helper supports one root CA and one directly signed leaf. */
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
