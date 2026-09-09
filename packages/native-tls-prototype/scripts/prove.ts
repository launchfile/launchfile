import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { TLSSocket } from 'node:tls';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';
import { compileDockerTls } from '../src/docker';
import { createCertificates, type CertificateFiles } from './certificates';

type Mode = 'off' | 'edge' | 'native' | 'passthrough' | 'reencrypt';
type RunningServer = { port: number; close: () => Promise<void> };
type Probe = { status: number; body: string; fingerprint?: string };
type Assertion = { name: string; passed: boolean; detail?: string };

const execute = promisify(execFile);
const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const evidenceFile = join(packageDirectory, 'evidence/live-proof.json');
const projectName = `launchfile-tls-proof-${randomUUID().slice(0, 12)}`;
const assertions: Assertion[] = [];
const servers = new Set<RunningServer>();
const report: {
  timestamp: string;
  runtime: string;
  image: { reference: string; id?: string; digests?: string[] };
  assertions: Assertion[];
  deployments: Array<{ mode: string; status: string; listenerPort: number; certificateIdentity: string }>;
  cleanup: { containersRemoved: boolean; volumesRemoved: boolean; temporaryFilesRemoved: boolean };
  passed: boolean;
  failure?: string;
} = {
  timestamp: new Date().toISOString(),
  runtime: `Bun ${Bun.version}`,
  image: { reference: 'gitea/gitea:latest' },
  assertions,
  deployments: [],
  cleanup: { containersRemoved: false, volumesRemoved: false, temporaryFilesRemoved: false },
  passed: false,
};

let temporaryDirectory = '';
let composeFile = '';
let startedDocker = false;
let failure: unknown;

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(temporaryDirectory || '\0', '[temporary-directory]').slice(0, 1500);
}

function verify(name: string, condition: unknown, detail?: string): void {
  assertions.push({ name, passed: Boolean(condition), ...(detail ? { detail } : {}) });
  assert.ok(condition, name);
  console.log(`PASS ${name}`);
}

async function docker(args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execute('docker', args, { timeout, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function compose(args: string[], timeout = 120_000): Promise<string> {
  return docker(['compose', '-p', projectName, '-f', composeFile, ...args], timeout);
}

async function listen(server: net.Server): Promise<RunningServer> {
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const running = {
    port: address.port,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      servers.delete(running);
    },
  };
  servers.add(running);
  return running;
}

async function availablePort(): Promise<number> {
  const temporary = await listen(net.createServer());
  const port = temporary.port;
  await temporary.close();
  // Docker cannot inherit this socket. A collision is a deployment failure, never a fallback.
  return port;
}

async function probe(port: number, options?: { ca: Buffer; servername?: string }): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const transport = options ? https : http;
    const request = transport.request({
      hostname: '127.0.0.1', port, path: '/api/v1/version', method: 'GET',
      agent: false, timeout: 5000,
      ...(options ? { ca: options.ca, servername: options.servername ?? 'localhost', rejectUnauthorized: true } : {}),
    }, (response) => {
      let body = '';
      const socket = response.socket as TLSSocket;
      const fingerprint = options ? socket.getPeerCertificate().fingerprint256 : undefined;
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body, fingerprint }));
    });
    request.once('timeout', () => request.destroy(new Error('HTTP probe timed out')));
    request.once('error', reject);
    request.end();
  });
}

async function expectTlsRejection(name: string, action: () => Promise<unknown>, expected: 'trust' | 'hostname'): Promise<void> {
  let code = '';
  try { await action(); } catch (error) {
    code = String((error as NodeJS.ErrnoException).code ?? '');
  }
  const trustErrors = ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_SIGNATURE_FAILURE'];
  verify(name, expected === 'hostname' ? code === 'ERR_TLS_CERT_ALTNAME_INVALID' : trustErrors.includes(code), code || 'TLS connection unexpectedly accepted');
}

async function tlsProxy(
  identity: CertificateFiles,
  backendPort: number,
  backendTls?: { ca: Buffer; servername?: string },
): Promise<RunningServer & { upstreamFingerprints: Set<string>; upstreamErrors: Set<string> }> {
  const upstreamFingerprints = new Set<string>();
  const upstreamErrors = new Set<string>();
  const server = https.createServer({
    cert: await readFile(identity.certFile), key: await readFile(identity.keyFile),
  }, (request, response) => {
    const transport = backendTls ? https : http;
    const upstream = transport.request({
      hostname: '127.0.0.1', port: backendPort, path: request.url,
      method: request.method, headers: { ...request.headers, host: 'localhost' },
      agent: false, timeout: 5000,
      ...(backendTls ? { ca: backendTls.ca, servername: backendTls.servername ?? 'localhost', rejectUnauthorized: true } : {}),
    }, (upstreamResponse) => {
      if (backendTls) {
        const fingerprint = (upstreamResponse.socket as TLSSocket).getPeerCertificate().fingerprint256;
        if (fingerprint) upstreamFingerprints.add(fingerprint);
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once('error', (error: NodeJS.ErrnoException) => {
      upstreamErrors.add(error.code ?? 'UNKNOWN');
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Backend TLS verification or connection failed' }));
    });
    upstream.once('timeout', () => upstream.destroy(new Error('Upstream timed out')));
    response.once('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  return { ...await listen(server), upstreamFingerprints, upstreamErrors };
}

async function passthrough(backendPort: number): Promise<RunningServer> {
  return listen(net.createServer((client) => {
    const backend = net.connect({ host: '127.0.0.1', port: backendPort });
    client.pipe(backend).pipe(client);
    client.once('error', () => backend.destroy());
    backend.once('error', () => client.destroy());
    client.once('close', () => backend.destroy());
    backend.once('close', () => client.destroy());
  }));
}

async function waitHealthy(service: string): Promise<string> {
  const deadline = Date.now() + 120_000;
  let lastState = 'not-created';
  while (Date.now() < deadline) {
    const containerId = await compose(['ps', '-q', service], 10_000);
    if (containerId) {
      const state = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', containerId], 10_000));
      lastState = `${state.Status}/${state.Health?.Status ?? 'no-healthcheck'}`;
      if (state.Health?.Status === 'healthy') return containerId;
      if (state.Status === 'exited' || state.Status === 'dead') throw new Error(`Owned Gitea container stopped: ${lastState}`);
    }
    await delay(1500);
  }
  throw new Error(`Owned Gitea container did not become healthy within 120 seconds: ${lastState}`);
}

async function compilationRejects(name: string, yaml: string, options: Parameters<typeof compileDockerTls>[1], reason: RegExp): Promise<void> {
  let message = '';
  try { await compileDockerTls(yaml, options); } catch (error) { message = cleanError(error); }
  verify(name, reason.test(message) && !startedDocker, message || 'Compilation unexpectedly accepted');
}

try {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'launchfile-tls-proof-$literal-'));
  composeFile = join(temporaryDirectory, 'compose.yaml');
  const certificates = await createCertificates(temporaryDirectory);
  const ca = await readFile(certificates.caFile);
  const wrongCa = await readFile(certificates.wrongCaFile);
  verify('Edge and backend use distinct certificate identities', certificates.edge.fingerprint !== certificates.backend.fingerprint);
  const keyPermissions = await Promise.all([certificates.edge, certificates.backend, certificates.wrongHost]
    .map(async (certificate) => (await stat(certificate.keyFile)).mode & 0o777));
  verify('Private leaf keys have mode 0600', keyPermissions.every((mode) => mode === 0o600));

  const source = await readFile(join(packageDirectory, 'examples/gitea/Launchfile'), 'utf8');
  const fixture = parse(source);
  fixture.env = {
    ...fixture.env,
    USER_UID: String(process.getuid?.() ?? 1000),
    USER_GID: String(process.getgid?.() ?? 1000),
  };
  const yaml = stringify(fixture);
  const backendPort = await availablePort();
  const baseOptions = { endpoint: 'web', hostPort: backendPort, projectName, serverName: 'localhost' };
  const certificateBindings = { 'server-cert': certificates.backend };
  const unsupported = structuredClone(fixture);
  delete unsupported.provides.find((endpoint: { name: string }) => endpoint.name === 'web').tls;
  await compilationRejects('Unsupported native TLS is rejected before Docker starts', stringify(unsupported), {
    ...baseOptions, mode: 'native', publicUrl: `https://localhost:${backendPort}`, certificates: certificateBindings,
  }, /does not declare native TLS support/);
  await compilationRejects('Missing certificate material is rejected before Docker starts', yaml, {
    ...baseOptions, mode: 'native', publicUrl: `https://localhost:${backendPort}`,
  }, /requires supplied certificate material|Missing certificate material/);
  await compilationRejects('Client-only certificate is rejected before Docker starts', yaml, {
    ...baseOptions, mode: 'native', publicUrl: `https://localhost:${backendPort}`,
    certificates: { 'server-cert': certificates.clientOnly },
  }, /TLS server certificate verification failed/);
  const image = JSON.parse(await docker(['image', 'inspect', fixture.image]))[0];
  report.image = { reference: fixture.image, id: image.Id, digests: image.RepoDigests ?? [] };
  const marker = randomUUID();
  let initialVolumes: string[] = [];
  const scenarios: Array<{ mode: Mode; label: string; port: number; expanded?: boolean }> = [
    { mode: 'off', label: 'off', port: 3000 },
    { mode: 'edge', label: 'edge', port: 3000 },
    { mode: 'native', label: 'native', port: 3000 },
    { mode: 'passthrough', label: 'passthrough', port: 3000 },
    { mode: 'reencrypt', label: 'reencrypt', port: 3000 },
    { mode: 'native', label: 'native-expanded-port', port: 3443, expanded: true },
    { mode: 'off', label: 'return-to-http', port: 3000 },
  ];

  for (const scenario of scenarios) {
    console.log(`Deploying owned fixture: ${scenario.label}`);
    const native = ['native', 'passthrough', 'reencrypt'].includes(scenario.mode);
    let front: RunningServer | undefined;
    let reencryptProxy: Awaited<ReturnType<typeof tlsProxy>> | undefined;
    if (scenario.mode === 'edge') front = await tlsProxy(certificates.edge, backendPort);
    if (scenario.mode === 'passthrough') front = await passthrough(backendPort);
    if (scenario.mode === 'reencrypt') front = reencryptProxy = await tlsProxy(certificates.edge, backendPort, { ca });
    const publicPort = front?.port ?? backendPort;
    const publicUrl = `${scenario.mode === 'off' ? 'http' : 'https'}://localhost:${publicPort}`;
    const selected = structuredClone(fixture);
    if (scenario.expanded) selected.provides.find((endpoint: { name: string }) => endpoint.name === 'web').tls = { certificate: 'server-cert', port: 3443 };
    const compiled = await compileDockerTls(stringify(selected), {
      ...baseOptions, mode: scenario.mode, publicUrl,
      ...(native ? { certificates: certificateBindings } : {}),
    });
    verify(`${scenario.label}: plan selects expected listener port`, compiled.plan.port === scenario.port);
    await writeFile(composeFile, compiled.compose, { mode: 0o600 });
    startedDocker = true;
    await compose(['up', '--detach', '--no-build']);
    const containerId = await waitHealthy(compiled.service);
    const portBindings = JSON.parse(await docker(['inspect', '--format', '{{json .HostConfig.PortBindings}}', containerId]));
    const selectedBindings = portBindings[`${scenario.port}/tcp`];
    verify(`${scenario.label}: selected listener is published only on loopback`,
      Object.keys(portBindings).length === 1 && selectedBindings?.length === 1 &&
      selectedBindings[0].HostIp === '127.0.0.1' && selectedBindings[0].HostPort === String(backendPort));
    const volumeNames = JSON.parse(await docker(['inspect', '--format', '{{json .Mounts}}', containerId]))
      .filter((mount: { Type: string }) => mount.Type === 'volume')
      .map((mount: { Name: string }) => mount.Name).sort();
    if (scenario.label === 'off') {
      initialVolumes = volumeNames;
      verify('Gitea has persistent named data volume', initialVolumes.length > 0);
      await docker(['exec', containerId, 'sh', '-c', 'printf %s "$1" > /data/.tls-prototype-proof', 'proof', marker]);
    } else {
      verify(`${scenario.label}: same named data volume retained`, JSON.stringify(volumeNames) === JSON.stringify(initialVolumes));
      verify(`${scenario.label}: data survives configuration switch`, await docker(['exec', containerId, 'cat', '/data/.tls-prototype-proof']) === marker);
    }

    const result = await probe(publicPort, scenario.mode === 'off' ? undefined : { ca });
    verify(`${scenario.label}: real Gitea responds with its version`, result.status === 200 && typeof JSON.parse(result.body).version === 'string');
    const expectedIdentity = scenario.mode === 'off' ? 'none' : ['edge', 'reencrypt'].includes(scenario.mode) ? 'edge' : 'backend';
    if (expectedIdentity !== 'none') {
      verify(`${scenario.label}: client sees ${expectedIdentity} certificate`, result.fingerprint === certificates[expectedIdentity].fingerprint);
    }
    if (reencryptProxy) {
      verify('Re-encryption independently authenticates backend certificate', reencryptProxy.upstreamFingerprints.has(certificates.backend.fingerprint));
      verify('Re-encryption has no upstream verification failures', reencryptProxy.upstreamErrors.size === 0);
    }
    verify(`${scenario.label}: Docker health check passes`, true);
    report.deployments.push({ mode: scenario.label, status: 'healthy', listenerPort: scenario.port, certificateIdentity: expectedIdentity });

    if (scenario.mode === 'native' && !scenario.expanded) {
      await expectTlsRejection('Native client rejects an untrusted CA', () => probe(backendPort, { ca: wrongCa }), 'trust');
      await expectTlsRejection('Native client rejects a mismatched backend hostname', () => probe(backendPort, { ca, servername: 'wrong.invalid' }), 'hostname');
    }
    if (scenario.mode === 'reencrypt') {
      const wrongTrustProxy = await tlsProxy(certificates.edge, backendPort, { ca: wrongCa });
      verify('Re-encryption fails closed when backend CA is untrusted', (await probe(wrongTrustProxy.port, { ca })).status === 502 && wrongTrustProxy.upstreamErrors.size > 0);
      await wrongTrustProxy.close();
      const impostor = await listen(https.createServer({
        cert: await readFile(certificates.wrongHost.certFile), key: await readFile(certificates.wrongHost.keyFile),
      }, (_request, response) => response.end('Impostor must never be accepted')));
      const wrongLeafProxy = await tlsProxy(certificates.edge, impostor.port, { ca });
      verify('Re-encryption rejects a trusted leaf with the wrong backend identity',
        (await probe(wrongLeafProxy.port, { ca })).status === 502 && wrongLeafProxy.upstreamErrors.has('ERR_TLS_CERT_ALTNAME_INVALID'));
      await wrongLeafProxy.close();
      await impostor.close();
    }
    if (front) await front.close();
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = cleanError(error);
  console.error(report.failure);
} finally {
  for (const server of [...servers]) {
    try { await server.close(); } catch (error) { failure ??= error; }
  }
  try {
    if (startedDocker) await compose(['down', '--volumes', '--remove-orphans', '--timeout', '10'], 60_000);
    const containers = await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${projectName}`]);
    const volumes = await docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${projectName}`]);
    report.cleanup.containersRemoved = containers === '';
    report.cleanup.volumesRemoved = volumes === '';
    verify('Only this proof project was cleaned; no owned containers or volumes remain', containers === '' && volumes === '');
  } catch (error) {
    failure ??= error;
    report.failure ??= cleanError(error);
  }
  try {
    if (temporaryDirectory) {
      // The proof creates a flat, private directory. Refuse unexpected directories.
      const files = await readdir(temporaryDirectory, { withFileTypes: true });
      assert.ok(files.every((file) => file.isFile() || file.isSymbolicLink()), 'Unexpected directory in proof scratch space');
      for (const file of files) await unlink(join(temporaryDirectory, file.name));
      await rmdir(temporaryDirectory);
    }
    report.cleanup.temporaryFilesRemoved = true;
  } catch (error) {
    failure ??= error;
    report.failure ??= cleanError(error);
  }
  report.passed = report.passed && !failure && Object.values(report.cleanup).every(Boolean);
  await mkdir(dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Evidence: ${evidenceFile}`);
  console.log(report.passed ? 'Live Docker TLS proof passed.' : 'Live Docker TLS proof failed.');
}

if (!report.passed) process.exitCode = 1;
