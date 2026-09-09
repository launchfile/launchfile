import { describe, expect, it } from "bun:test";
import { registerDeclaredSecret, redactSecrets } from "@launchfile/docker";
import { decide, redactDiagnostic, runWithPolicy, type Diagnostic } from "../src/policy.js";

const schedule: Diagnostic = {
  code: "SCHEDULE_NOT_EXECUTED", component: "cron", field: "schedule",
  reason: "No provider scheduler.", next_action: "Choose a scheduler-capable provider.",
  phase: "execution", severity: "warning",
};

describe("stable code policy", () => {
  it("retains the exact warning object when strictness adds refusal", () => {
    const decision = decide([schedule], "strict-schedule");
    expect(decision.allowed).toBe(false);
    expect(decision.diagnostics[0]).toBe(schedule);
    expect(decision.diagnostics[1]).toEqual({ ...schedule,
      code: "STRICT_POLICY_REFUSAL", severity: "error",
      reason: "The requested operator policy refuses an unexecuted schedule." });
  });
  it("keeps default diagnostics byte-for-byte unchanged", () => {
    expect(JSON.stringify(decide([schedule]).diagnostics)).toBe(JSON.stringify([schedule]));
    expect(decide([schedule]).allowed).toBe(true);
  });
  it("matches the code even when wording and field display change", () => {
    expect(decide([{ ...schedule, field: "translated-name", reason: "localized notice" }], "strict-schedule").allowed).toBe(false);
  });
  it.each(["D40_REDUCED_PORTABILITY", "D46_RESOURCE_PROPERTY", "D56_RESOURCE_PROPERTY", "FUTURE_UNKNOWN"])(
    "does not promote %s, even with schedule-like text", (code) => {
      const diagnostic = { ...schedule, code, reason: "schedule not executed" };
      const decision = decide([diagnostic], "strict-schedule");
      expect(decision.allowed).toBe(true);
      expect(decision.diagnostics).toEqual([diagnostic]);
    });
  it("does not import validation-only diagnostics into execution policy", () => {
    const validation = { ...schedule, phase: "validation" as const };
    expect(decide([validation], "strict-schedule").diagnostics).toEqual([validation]);
  });
  it.each(["default", "strict-schedule"])("keeps mandatory errors under %s", (policy) => {
    const mandatory = { ...schedule, code: "REQUIRED_ENV_UNSUPPLIED", severity: "error" as const };
    expect(decide([mandatory], policy)).toEqual({ allowed: false, diagnostics: [mandatory] });
  });
  it.each(["default", "strict-schedule"])("does not waive validation errors under %s", async (policy) => {
    const diagnostic = { ...schedule, code: "INVALID_LAUNCHFILE", phase: "validation" as const, severity: "error" as const };
    let starts = 0;
    const result = await runWithPolicy([diagnostic], policy, () => {}, () => { starts += 1; });
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.diagnostics).toEqual([diagnostic]);
    expect(starts).toBe(0);
  });
  it("refuses an unsupported policy explicitly", () => {
    expect(decide([], "strict-schedule", false).diagnostics[0]?.code).toBe("POLICY_UNSUPPORTED");
    expect(decide([], "unknown-policy").allowed).toBe(false);
    expect(decide([], "default", false).allowed).toBe(true);
  });
  it("emits warning then refusal without calling start", async () => {
    const events: string[] = [];
    const result = await runWithPolicy([schedule], "strict-schedule",
      (d) => { events.push(d.code); }, () => { events.push("start"); });
    expect(result.started).toBe(false);
    expect(events).toEqual(["SCHEDULE_NOT_EXECUTED", "STRICT_POLICY_REFUSAL"]);
  });
  it("awaits diagnostic delivery before calling start", async () => {
    const events: string[] = [];
    await runWithPolicy([schedule], "default", async () => {
      await Promise.resolve(); events.push("warning");
    }, () => { events.push("start"); });
    expect(events).toEqual(["warning", "start"]);
  });
  it("preserves ordinary lifecycle failure and does not retry start", async () => {
    let calls = 0;
    await expect(runWithPolicy([], "default", () => {}, () => {
      calls += 1; throw new Error("start failed");
    })).rejects.toThrow("start failed");
    expect(calls).toBe(1);
  });
  it("reuses provider redaction on every display field, including short declared secrets", () => {
    registerDeclaredSecret("s3c");
    const diagnostic = redactDiagnostic({ ...schedule, component: "s3c", field: "env.s3c",
      reason: "connect https://user:private@host/s3c", next_action: "replace s3c" }, redactSecrets);
    expect(JSON.stringify(diagnostic)).not.toContain("s3c");
    expect(JSON.stringify(diagnostic)).not.toContain("private@");
    expect(diagnostic.code).toBe("SCHEDULE_NOT_EXECUTED");
    expect(JSON.stringify(decide([diagnostic], "strict-schedule"))).not.toContain("s3c");
  });
});
