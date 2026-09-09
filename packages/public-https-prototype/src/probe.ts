import { request } from "node:https";
import type { TLSSocket } from "node:tls";
import { publicationOrigin, type PublicHttpsPlan } from "./planner.js";

export interface ProbeOptions {
  /** Explicit trust root bytes; no change to the machine's trust store. */
  ca: string | Buffer;
  /** Out-of-band expected response, fresh and app-specific in the fixture. */
  expectedBody: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export interface RouteEvidence {
  component: string;
  endpoint: string;
  url: string;
  observedAt: string;
  status: "observed-authenticated-route";
  tlsProtocol: string;
  peerFingerprint256: string;
  responseStatus: 200;
  expectedResponseMatched: true;
  limitation: string;
}

/**
 * Observe a route from this machine. This is deliberately separate from the
 * pure plan, and does not mutate it into a production deployment success.
 */
export async function probePublicHttps(plan: PublicHttpsPlan, options: ProbeOptions): Promise<RouteEvidence> {
  if (plan.status !== "unresolved" || plan.requirements.length !== 1) {
    throw new Error("Probe requires one unresolved public HTTPS requirement");
  }
  const requirement = plan.requirements[0]!;
  if (requirement.reason !== "route-unverified" || requirement.url === undefined) {
    throw new Error("Probe requires a supplied HTTPS origin; unavailable publication context cannot be probed");
  }
  const origin = publicationOrigin(requirement.url);
  if (new URL(origin).protocol !== "https:") throw new Error("Probe requires an HTTPS origin");
  const timeoutMs = options.timeoutMs ?? 3000;
  const maxBodyBytes = options.maxBodyBytes ?? 65536;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("timeoutMs must be 1–30000");
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1048576) throw new Error("maxBodyBytes must be 1–1048576");
  if (!options.ca.length) throw new Error("Explicit CA trust is required");
  if (!options.expectedBody || Buffer.byteLength(options.expectedBody) > maxBodyBytes) {
    throw new Error("A nonempty expected response within maxBodyBytes is required");
  }

  return new Promise((resolve, reject) => {
    let completed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, evidence?: RouteEvidence) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(evidence!);
    };
    const req = request(new URL(origin), {
      method: "GET",
      agent: false,
      ca: options.ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      headers: { Accept: "text/plain", "Accept-Encoding": "identity", Connection: "close" },
    }, (res) => {
      const socket = res.socket as TLSSocket;
      const fail = (message: string) => {
        finish(new Error(message));
        res.destroy();
        req.destroy();
      };
      if (!socket.authorized) return fail("TLS authentication did not succeed");
      if (res.statusCode !== 200) return fail("Route must return 200; redirects are not followed");
      if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
        return fail("Encoded response bodies are outside this probe");
      }
      const fingerprint = socket.getPeerCertificate().fingerprint256;
      const tlsProtocol = socket.getProtocol();
      if (!fingerprint || !tlsProtocol) return fail("Authenticated peer evidence is unavailable");
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBodyBytes) return fail("Response exceeds maxBodyBytes");
        chunks.push(chunk);
      });
      res.on("error", () => finish(new Error("Route response failed")));
      res.on("aborted", () => finish(new Error("Route response was incomplete")));
      res.on("end", () => {
        if (!res.complete) return fail("Route response was incomplete");
        if (!Buffer.concat(chunks).equals(Buffer.from(options.expectedBody))) return fail("Route did not return the expected application response");
        finish(undefined, {
          component: requirement.component,
          endpoint: requirement.endpoint,
          url: origin,
          observedAt: new Date().toISOString(),
          status: "observed-authenticated-route",
          tlsProtocol,
          peerFingerprint256: fingerprint,
          responseStatus: 200,
          expectedResponseMatched: true,
          limitation: "Point-in-time evidence from this client. Trust and hostname plus caller-supplied response expectation; not proof of public reachability, routing ownership, deployment identity, or browser behavior.",
        });
      });
    });
    req.on("error", (error: NodeJS.ErrnoException) => finish(new Error(`HTTPS route probe failed (${error.code ?? "request error"})`)));
    // Wall-clock deadline bounds DNS lookup, TLS, headers, and a trickling body.
    timer = setTimeout(() => {
      finish(new Error("HTTPS route probe timed out"));
      req.destroy();
    }, timeoutMs);
    req.end();
  });
}
