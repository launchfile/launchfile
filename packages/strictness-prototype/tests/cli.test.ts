import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = fileURLToPath(new URL("..", import.meta.url));
for (const provider of ["docker", "aws", "macos-dev"]) {
  it(`${provider} reports a non-success strict result and unchanged warning`, () => {
    const baseline = Bun.spawnSync([process.execPath, "run", "src/cli.ts", provider, "fixtures/Launchfile"], { cwd });
    const strict = Bun.spawnSync([process.execPath, "run", "src/cli.ts", provider, "fixtures/Launchfile", "--strict"], { cwd });
    expect(baseline.exitCode).toBe(0);
    expect(strict.exitCode).toBe(1);
    const before = JSON.parse(baseline.stdout.toString());
    const after = JSON.parse(strict.stdout.toString());
    expect(after.diagnostics.filter((d: { severity: string }) => d.severity === "warning")).toEqual(before.diagnostics);
    expect(after.status).toContain("not deployment readiness");
  });
}
it("rejects unknown flags instead of silently ignoring requested strictness", () => {
  const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "aws", "fixtures/Launchfile", "--stricter"], { cwd });
  expect(result.exitCode).toBe(2);
});
it("does not expose raw YAML or a stack when parsing fails before redaction registration", () => {
  const directory = mkdtempSync(join(tmpdir(), "strictness-invalid-"));
  const path = join(directory, "Launchfile");
  const sentinel = "EXAMPLE_PRIVATE_SENTINEL_NEVER_PRINT";
  writeFileSync(path, `name: invalid\nenv:\n  PASSWORD: [${sentinel}\n`);
  try {
    const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "docker", path], { cwd });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("Cannot evaluate Launchfile. Check the file path and syntax; no application was started.\n");
    expect(result.stderr.toString()).not.toContain(sentinel);
  } finally {
    unlinkSync(path);
    rmdirSync(directory);
  }
});
it("refuses foreign contracts before strict policy can report success", () => {
  const directory = mkdtempSync(join(tmpdir(), "strictness-foreign-"));
  const path = join(directory, "Launchfile");
  writeFileSync(path, "name: foreign\nimage: example/app\nvariants: {}\n");
  try {
    const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "docker", path, "--strict"], { cwd });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("require their separate demonstrations");
  } finally {
    unlinkSync(path);
    rmdirSync(directory);
  }
});
