import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { planPublicHttps, type PublicHttpsOptions } from "../planner.js";
import { probePublicHttps } from "../probe.js";
import { createFixture, type EdgeBehavior } from "../../scripts/fixture.js";

const file = `name: test
provides: [{ name: web, protocol: http, port: 3000, exposed: true }]
requires: [{ public: { endpoint: web, scheme: https } }]
`;

describe("authenticated public-route observation", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  beforeAll(async () => { fixture = await createFixture(); }, 30000);
  beforeEach(() => fixture.setBehavior("proxy"));
  afterAll(async () => {
    await fixture.close();
    expect(await fixture.cleanupVerified()).toBe(true);
  });
  const plan = (url: string) => planPublicHttps(file, { publicUrl: url });
  const options = () => ({ ca: fixture.ca, expectedBody: fixture.marker });

  it("observes an authenticated HTTPS edge forwarding to an HTTP app", async () => {
    const unresolved = plan(fixture.edgeUrl);
    const prior = fixture.appRequests();
    const evidence = await probePublicHttps(unresolved, options());
    expect(evidence.status).toBe("observed-authenticated-route");
    expect(evidence.peerFingerprint256).toBe(fixture.edgeFingerprint);
    expect(evidence.expectedResponseMatched).toBe(true);
    expect(fixture.appRequests()).toBe(prior + 1);
    expect(unresolved.status).toBe("unresolved");
    expect(unresolved.launch.components.default?.provides?.[0]?.protocol).toBe("http");
  });

  it("rejects an untrusted CA", async () => {
    await expect(probePublicHttps(plan(fixture.edgeUrl), { ...options(), ca: fixture.wrongCa })).rejects.toThrow("probe failed");
  });

  it("rejects a certificate issued for a different hostname", async () => {
    await expect(probePublicHttps(plan(fixture.wrongHostUrl), options())).rejects.toThrow("probe failed");
  });

  it("rejects an unavailable endpoint even though the plan contains HTTPS", async () => {
    await expect(probePublicHttps(plan(fixture.unavailableUrl), options())).rejects.toThrow("probe failed");
  });

  it("never follows an HTTPS-to-HTTP redirect", async () => {
    fixture.setBehavior("redirect");
    const prior = fixture.appRequests();
    await expect(probePublicHttps(plan(fixture.edgeUrl), options())).rejects.toThrow("redirects are not followed");
    expect(fixture.appRequests()).toBe(prior);
  });

  it.each<[EdgeBehavior, string]>([
    ["wrong-body", "expected application response"],
    ["too-large", "maxBodyBytes"],
    ["error-status", "return 200"],
    ["encoded", "Encoded response"],
  ])("rejects %s responses", async (behavior, message) => {
    fixture.setBehavior(behavior);
    await expect(probePublicHttps(plan(fixture.edgeUrl), options())).rejects.toThrow(message);
  });

  it("enforces a wall-clock timeout", async () => {
    fixture.setBehavior("stall");
    const start = Date.now();
    await expect(probePublicHttps(plan(fixture.edgeUrl), { ...options(), timeoutMs: 50 })).rejects.toThrow("timed out");
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it.each([
    { timeoutMs: 0 }, { timeoutMs: 30001 }, { maxBodyBytes: 0 },
    { maxBodyBytes: 1048577 }, { ca: "" }, { expectedBody: "" },
  ])("rejects invalid probe policy before connecting: %j", async (override) => {
    const prior = fixture.appRequests();
    await expect(probePublicHttps(plan(fixture.edgeUrl), { ...options(), ...override })).rejects.toThrow();
    expect(fixture.appRequests()).toBe(prior);
  });

  it("refuses a plan without the requirement", async () => {
    await expect(probePublicHttps(planPublicHttps("name: ordinary"), options())).rejects.toThrow("one unresolved");
  });

  it.each<PublicHttpsOptions>([{}, { publication: "no-channel" }, { publication: "after-apply" }, { mode: "translate" }, { publicUrl: "http://app.example" }])(
    "does not probe unavailable, unevaluated, or mismatched publication context: %j", async (context) => {
      const prior = fixture.appRequests();
      await expect(probePublicHttps(planPublicHttps(file, context), options())).rejects.toThrow();
      expect(fixture.appRequests()).toBe(prior);
    },
  );
});
