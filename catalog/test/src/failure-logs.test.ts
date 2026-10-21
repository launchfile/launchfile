import { describe, expect, it } from "vitest";
import {
  collectFailureLogs,
  formatServiceLogs,
  parseServices,
  type Run,
  type RunResult,
  tailText,
} from "./failure-logs.ts";

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", exitCode: 0 });

/** A fake `run` that answers by joined command line and records every call. */
function fakeRun(answers: Record<string, RunResult>): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = async (cmd) => {
    calls.push(cmd);
    const answer = answers[cmd.join(" ")];
    if (!answer) throw new Error(`unexpected command: ${cmd.join(" ")}`);
    return answer;
  };
  return { run, calls };
}

describe("parseServices", () => {
  it("keeps compose's order and drops blank lines", () => {
    expect(parseServices("web\n\ndb\nredis\n")).toEqual(["web", "db", "redis"]);
  });

  it("returns nothing for empty output", () => {
    expect(parseServices("\n")).toEqual([]);
  });
});

describe("tailText", () => {
  it("returns short text unchanged", () => {
    expect(tailText("a\nb\n")).toBe("a\nb\n");
  });

  it("drops the partial first line and marks the cut", () => {
    const text = `${"x".repeat(1500)}\n${"y".repeat(1000)}\n${"z".repeat(500)}\n`;
    const out = tailText(text);
    expect(out.startsWith("…(truncated)\n")).toBe(true);
    expect(out).not.toContain("x");
    expect(out).toContain(`${"y".repeat(1000)}\n`);
    expect(out.endsWith(`${"z".repeat(500)}\n`)).toBe(true);
  });
});

describe("formatServiceLogs", () => {
  it("prints the header and the tail", () => {
    expect(formatServiceLogs("app", ok("app-1  | listening\n"))).toBe("--- app ---\napp-1  | listening\n");
  });

  it("prints (no output) when stdout is empty", () => {
    expect(formatServiceLogs("app", ok(""))).toBe("--- app ---\n(no output)");
  });

  it("prints the exit code and the last 500 chars of stderr on failure", () => {
    const stderr = `${"e".repeat(600)}no such service`;
    const out = formatServiceLogs("app", { stdout: "", stderr, exitCode: 1 });
    expect(out).toBe(`--- app ---\nlogs exited 1: ${stderr.slice(-500)}`);
  });
});

describe("collectFailureLogs", () => {
  it("gives each service its own header and tail, so a chatty db cannot hide the app", async () => {
    const chattyDb = `${"db-1  | checkpoint\n".repeat(500)}`;
    const { run, calls } = fakeRun({
      "docker compose config --services": ok("app\ndb\n"),
      "docker compose logs --no-color --tail 30 app": ok("app-1  | panic: cannot connect\n"),
      "docker compose logs --no-color --tail 30 db": ok(chattyDb),
    });

    const out = await collectFailureLogs(run);

    expect(out).toContain("--- Container logs (last 30 lines per service) ---");
    expect(out).toContain("--- app ---\napp-1  | panic: cannot connect");
    expect(out).toContain("--- db ---\n…(truncated)\n");
    expect(out.indexOf("--- app ---")).toBeLessThan(out.indexOf("--- db ---"));
    expect(calls.map((c) => c.at(-1))).toEqual(["--services", "app", "db"]);
  });

  it("never skips a service whose logs are empty or fail", async () => {
    const { run } = fakeRun({
      "docker compose config --services": ok("app\ndb\n"),
      "docker compose logs --no-color --tail 30 app": ok(""),
      "docker compose logs --no-color --tail 30 db": { stdout: "", stderr: "boom", exitCode: 2 },
    });

    const out = await collectFailureLogs(run);

    expect(out).toContain("--- app ---\n(no output)");
    expect(out).toContain("--- db ---\nlogs exited 2: boom");
  });

  it("falls back to the combined tail and prints stderr when config --services fails", async () => {
    const { run, calls } = fakeRun({
      "docker compose config --services": { stdout: "", stderr: "invalid compose file", exitCode: 15 },
      "docker compose logs --tail 30": ok(`${"m".repeat(2500)}`),
    });

    const out = await collectFailureLogs(run);

    expect(out).toContain("invalid compose file");
    expect(out.endsWith("m".repeat(2000))).toBe(true);
    expect(out).not.toContain("m".repeat(2001));
    expect(calls).toHaveLength(2);
  });

  it("falls back to the combined tail when config --services lists nothing", async () => {
    const { run, calls } = fakeRun({
      "docker compose config --services": ok("\n"),
      "docker compose logs --tail 30": ok("combined\n"),
    });

    const out = await collectFailureLogs(run);

    expect(out.endsWith("combined\n")).toBe(true);
    expect(calls.at(-1)).toEqual(["docker", "compose", "logs", "--tail", "30"]);
  });
});
