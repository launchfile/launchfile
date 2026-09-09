import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { planPublicHttps } from "../src/planner.js";
import { probePublicHttps, type RouteEvidence } from "../src/probe.js";
import { createFixture } from "./fixture.js";

const file = await readFile(new URL("../examples/Launchfile", import.meta.url), "utf8");
const fixture = await createFixture();
const checks: string[] = [];
let evidence: RouteEvidence | undefined;
const plan = (publicUrl: string) => planPublicHttps(file, { publicUrl });
const probeOptions = { ca: fixture.ca, expectedBody: fixture.marker };
try {
  assert.throws(() => plan(fixture.appUrl), /must use HTTPS/);
  checks.push("Public HTTP rejected before probing");
  const unresolved = plan(fixture.edgeUrl);
  assert.equal(unresolved.status, "unresolved");
  assert.equal(fixture.appRequests(), 0);
  checks.push("HTTPS publication string remains unresolved; planning performs no I/O");
  evidence = await probePublicHttps(unresolved, probeOptions);
  assert.equal(evidence.peerFingerprint256, fixture.edgeFingerprint);
  assert.equal(fixture.appRequests(), 1);
  assert.equal(unresolved.launch.components.default?.provides?.[0]?.protocol, "http");
  assert.equal(unresolved.status, "unresolved");
  checks.push("CA and hostname verified at the HTTPS edge; fresh response traversed the HTTP app");
  checks.push("App listener remains HTTP and route evidence does not mutate the pure plan");

  await assert.rejects(probePublicHttps(plan(fixture.edgeUrl), { ...probeOptions, ca: fixture.wrongCa }), /probe failed/);
  checks.push("Untrusted CA rejected");
  await assert.rejects(probePublicHttps(plan(fixture.wrongHostUrl), probeOptions), /probe failed/);
  checks.push("Wrong hostname rejected");
  await assert.rejects(probePublicHttps(plan(fixture.unavailableUrl), probeOptions), /probe failed/);
  checks.push("Unavailable HTTPS route rejected");
  fixture.setBehavior("redirect");
  const beforeRedirect = fixture.appRequests();
  await assert.rejects(probePublicHttps(plan(fixture.edgeUrl), probeOptions), /redirects are not followed/);
  assert.equal(fixture.appRequests(), beforeRedirect);
  checks.push("Redirect downgrade refused without requesting its HTTP target");
  fixture.setBehavior("wrong-body");
  await assert.rejects(probePublicHttps(plan(fixture.edgeUrl), probeOptions), /expected application response/);
  checks.push("An authenticated edge with the wrong application response rejected");
  fixture.setBehavior("too-large");
  await assert.rejects(probePublicHttps(plan(fixture.edgeUrl), probeOptions), /maxBodyBytes/);
  checks.push("Oversized response rejected");
  fixture.setBehavior("stall");
  await assert.rejects(probePublicHttps(plan(fixture.edgeUrl), { ...probeOptions, timeoutMs: 50 }), /timed out/);
  checks.push("Unresponsive route bounded by a wall-clock deadline");
} finally {
  await fixture.close();
}
assert.equal(await fixture.cleanupVerified(), true);
checks.push("Owned loopback servers, sockets, and disposable certificate files removed");
console.log(JSON.stringify({
  result: "passed",
  checks,
  routeEvidence: evidence,
  cleanupVerified: true,
  boundaries: "Local route experiment only. No actual catalog app, Docker deployment, public DNS, browser flow, routing ownership, or production provider integration was tested.",
}, null, 2));
