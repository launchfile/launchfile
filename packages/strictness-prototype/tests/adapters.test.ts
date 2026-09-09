import { describe, expect, it } from "bun:test";
import { readLaunch } from "@launchfile/sdk";
import { launchToCompose } from "@launchfile/docker";
import { translate } from "@launchfile/aws";
import { scheduleWarning } from "@launchfile/macos-dev/dist/provider.js";
import { observe, scheduleDiagnostics, type Provider } from "../src/adapters.js";
import { decide, runWithPolicy } from "../src/policy.js";

const yaml = await Bun.file(new URL("../fixtures/Launchfile", import.meta.url)).text();
const fixture = readLaunch(yaml);
const providers: Provider[] = ["docker", "aws", "macos-dev"];

describe("provider seams", () => {
  it("real Docker composition keeps its original warning and YAML", () => {
    const expected = launchToCompose(fixture);
    expect(observe("docker", fixture).original).toEqual(expected);
    expect(expected.warnings.join(" ")).toContain("declares a schedule");
    expect(expected.yaml).toContain("example/nightly-job:latest");
  });
  it("real AWS translation retains its conformance gap and HCL", () => {
    const expected = translate(fixture);
    expect(observe("aws", fixture).original).toEqual(expected);
    expect(expected.conformance.gaps.some((g) => g.field === "schedule")).toBe(true);
    expect(expected.hcl).toContain('resource "aws_instance"');
  });
  it("macOS uses the production schedule warning helper without launchUp", () => {
    expect(observe("macos-dev", fixture).original).toEqual({ warnings: [scheduleWarning("default", "0 2 * * *")] });
  });
  it("all three proposed adapters emit the same required structured record", () => {
    const records = providers.map((p) => observe(p, fixture).diagnostics.find((d) => d.code === "SCHEDULE_NOT_EXECUTED"));
    expect(records[0]).toBeDefined();
    expect(records[1]).toEqual(records[0]);
    expect(records[2]).toEqual(records[0]);
    expect(records[0]).toMatchObject({ component: "default", field: "schedule", severity: "warning" });
  });
  it.each(providers)("%s default proceeds while strict refuses before the lifecycle callback", async (provider) => {
    const observation = observe(provider, fixture);
    const original = JSON.stringify(observation.original);
    for (const policy of ["default", "strict-schedule"]) {
      let starts = 0;
      const emitted: string[] = [];
      const result = await runWithPolicy(observation.diagnostics, policy,
        (d) => { emitted.push(d.code); }, () => { starts += 1; });
      expect(starts).toBe(policy === "default" ? 1 : 0);
      expect(result.decision.allowed).toBe(policy === "default");
      expect(emitted).toContain("SCHEDULE_NOT_EXECUTED");
    }
    expect(JSON.stringify(observation.original)).toBe(original);
  });
  it.each(providers)("%s required env remains a failure in both policies", (provider) => {
    const launch = readLaunch(`${yaml}\nenv:\n  OPERATOR_TOKEN:\n    required: true\n    sensitive: true\n`);
    const observation = observe(provider, launch);
    expect(observation.diagnostics.some((d) => d.code === "REQUIRED_ENV_UNSUPPLIED")).toBe(true);
    for (const policy of ["default", "strict-schedule"]) expect(decide(observation.diagnostics, policy).allowed).toBe(false);
  });
  it.each(providers)("%s mandatory host refusal remains a failure in both policies", (provider) => {
    const launch = readLaunch(`${yaml}\nrequires:\n  - host:\n      container_runtime: docker\n`);
    const observation = observe(provider, launch);
    expect(observation.diagnostics.some((d) => d.code === "REQUIRED_HOST_REFUSED")).toBe(true);
    for (const policy of ["default", "strict-schedule"]) expect(decide(observation.diagnostics, policy).allowed).toBe(false);
  });
  it("keeps a satisfied schedule eligible for continuation (synthetic capability, no scheduler implemented)", () => {
    const diagnostics = scheduleDiagnostics(fixture, true);
    expect(diagnostics).toEqual([]);
    expect(decide(diagnostics, "strict-schedule").allowed).toBe(true);
  });
  it("only emits gaps for components that declare schedule", () => {
    const launch = readLaunch("name: pair\ncomponents:\n  worker:\n    image: example/job\n    schedule: '0 0 * * *'\n  web:\n    image: example/web\n");
    expect(scheduleDiagnostics(launch, false).map((d) => d.component)).toEqual(["worker"]);
  });
});
