import { createServer as httpServer, request as httpRequest, type Server, type RequestListener } from "node:http";
import { createServer as httpsServer } from "node:https";
import type { Socket } from "node:net";
import { mkdtemp, readFile, readdir, unlink, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCertificates } from "./certificates.js";

export type EdgeBehavior = "proxy" | "redirect" | "wrong-body" | "too-large" | "stall" | "error-status" | "encoded";

/** Owns only these loopback listeners and this new disposable PKI directory. */
export async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "launchfile-public-https-"));
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  let appRequests = 0;
  let behavior: EdgeBehavior = "proxy";
  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
  }

  async function listen(server: Server): Promise<number> {
    servers.push(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a loopback TCP listener");
    return address.port;
  }

  try {
    const certificates = await createCertificates(directory);
    const marker = `http-app:${randomUUID()}\n`;
    const app = httpServer((_req, res) => {
      appRequests++;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(marker);
    });
    const appPort = await listen(app);

    const route: RequestListener = (_req, res) => {
      if (behavior === "redirect") {
        res.writeHead(302, { Location: `http://127.0.0.1:${appPort}` });
        res.end();
        return;
      }
      if (behavior === "stall") return;
      if (behavior === "error-status") { res.writeHead(503); res.end("unavailable"); return; }
      if (behavior === "encoded") { res.writeHead(200, { "Content-Encoding": "gzip" }); res.end(marker); return; }
      if (behavior === "wrong-body") { res.end("another application"); return; }
      if (behavior === "too-large") { res.end("x".repeat(65537)); return; }
      const upstream = httpRequest({ hostname: "127.0.0.1", port: appPort, path: "/", method: "GET", agent: false }, (response) => {
        res.writeHead(response.statusCode ?? 502, { "Content-Type": "text/plain" });
        response.pipe(res);
      });
      upstream.setTimeout(2000, () => upstream.destroy(new Error("Fixture upstream timeout")));
      upstream.on("error", () => { res.writeHead(502); res.end("upstream unavailable"); });
      res.on("close", () => upstream.destroy());
      upstream.end();
    };

    const edgePort = await listen(httpsServer({
      cert: await readFile(certificates.edge.certFile),
      key: await readFile(certificates.edge.keyFile),
    }, route));
    const wrongHostPort = await listen(httpsServer({
      cert: await readFile(certificates.wrongHost.certFile),
      key: await readFile(certificates.wrongHost.keyFile),
    }, route));
    const unavailable = httpServer();
    const unavailablePort = await listen(unavailable);
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));

    return {
      marker,
      ca: await readFile(certificates.caFile),
      wrongCa: await readFile(certificates.wrongCaFile),
      edgeFingerprint: certificates.edge.fingerprint,
      appUrl: `http://127.0.0.1:${appPort}`,
      edgeUrl: `https://127.0.0.1:${edgePort}`,
      wrongHostUrl: `https://127.0.0.1:${wrongHostPort}`,
      unavailableUrl: `https://127.0.0.1:${unavailablePort}`,
      appRequests: () => appRequests,
      setBehavior(value: EdgeBehavior) { behavior = value; },
      close,
      async cleanupVerified() {
        let directoryRemoved = false;
        try { await stat(directory); } catch (error) {
          directoryRemoved = (error as NodeJS.ErrnoException).code === "ENOENT";
        }
        return directoryRemoved && servers.every((server) => !server.listening) && sockets.size === 0;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
