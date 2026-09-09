import { execFile } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const execute = promisify(execFile);

export interface CertificateFiles {
  certFile: string;
  keyFile: string;
  caFile: string;
  fingerprint: string;
}

/** Ephemeral test PKI: one trusted CA, an edge identity, and negative fixtures. */
export async function createCertificates(directory: string): Promise<{
  caFile: string;
  wrongCaFile: string;
  edge: CertificateFiles;
  wrongHost: CertificateFiles;
}> {
  async function openssl(args: string[]): Promise<void> {
    await execute('openssl', args, { timeout: 30_000, maxBuffer: 128 * 1024 });
  }

  async function authority(name: string): Promise<{ certFile: string; keyFile: string }> {
    const keyFile = join(directory, `${name}.key`);
    const certFile = join(directory, `${name}.pem`);
    // Pre-create keys with restrictive permissions, including during generation.
    await writeFile(keyFile, '', { mode: 0o600, flag: 'wx' });
    await openssl([
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
      '-subj', `/CN=Launchfile prototype ${name}`,
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-keyout', keyFile, '-out', certFile,
    ]);
    await chmod(keyFile, 0o600);
    return { certFile, keyFile };
  }

  const ca = await authority('root');
  const wrongCa = await authority('untrusted-root');

  async function leaf(name: string, alternativeNames: string): Promise<CertificateFiles> {
    const keyFile = join(directory, `${name}.key`);
    const csrFile = join(directory, `${name}.csr`);
    const certFile = join(directory, `${name}.pem`);
    const extensionsFile = join(directory, `${name}.ext`);
    await writeFile(keyFile, '', { mode: 0o600, flag: 'wx' });
    await writeFile(extensionsFile, [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=${alternativeNames}`,
      '',
    ].join('\n'), { mode: 0o600 });
    await openssl([
      'req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', `/CN=${name}`,
      '-keyout', keyFile, '-out', csrFile,
    ]);
    await openssl([
      'x509', '-req', '-sha256', '-days', '2', '-in', csrFile,
      '-CA', ca.certFile, '-CAkey', ca.keyFile, '-CAcreateserial',
      '-extfile', extensionsFile, '-out', certFile,
    ]);
    await chmod(keyFile, 0o600);
    const fingerprint = new X509Certificate(await readFile(certFile)).fingerprint256;
    return { certFile, keyFile, caFile: ca.certFile, fingerprint };
  }

  return {
    caFile: ca.certFile,
    wrongCaFile: wrongCa.certFile,
    edge: await leaf('edge', 'DNS:localhost,IP:127.0.0.1'),
    wrongHost: await leaf('wrong-host', 'DNS:wrong.invalid'),
  };
}
