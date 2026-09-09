import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cwd = new URL("..", import.meta.url).pathname;

describe("inspect CLI", () => {
  it("prints a normalized PostgreSQL selection with references unresolved", () => {
    const output = execFileSync("bun", ["run", "inspect", "examples/gitea/Launchfile", "--variant=postgres"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const preview = JSON.parse(output);
    expect(preview.experimental).toBe(true);
    expect(preview.selected).toBe("postgres");
    expect(preview.validated).toEqual(["baseline", "postgres"]);
    expect(preview.launch.components.default.requires[0].set_env.GITEA__database__PASSWD).toBe("$password");
  });

  it("prints no partial plan when an unselected variant is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "variants-cli-"));
    const file = join(dir, "Launchfile");
    try {
      writeFileSync(file, "name: app\nimage: app\nvariants:\n  broken:\n    env:\n      DB: $missing.url\n");
      const result = spawnSync("bun", ["run", "inspect", file], { cwd, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("variants.broken.env.DB");
    } finally { unlinkSync(file); rmdirSync(dir); }
  });

  it("redacts sensitive defaults and never loads secrets from the environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "variants-cli-"));
    const file = join(dir, "Launchfile");
    try {
      writeFileSync(file, "name: app\nimage: app\nsecrets:\n  key:\n    generator: secret\nenv:\n  TOKEN: literal-private\n  OTHER:\n    sensitive: true\n    default: also-private\n  REF: $secrets.key\nrequires:\n  - type: postgres\n    set_env:\n      PASSWORD: '${password:-FALLBACK_SECRET_SENTINEL}'\n");
      const result = spawnSync("bun", ["run", "inspect", file], { cwd, encoding: "utf8", env: { ...process.env, TOKEN: "environment-private" } });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/literal-private|also-private|environment-private/);
      expect(result.stdout).not.toContain("FALLBACK_SECRET_SENTINEL");
      expect(result.stdout).toContain("$secrets.key");
      expect(result.stdout).toContain("[redacted]");
    } finally { unlinkSync(file); rmdirSync(dir); }
  });

  it("does not echo malformed YAML values in diagnostics", () => {
    const dir = mkdtempSync(join(tmpdir(), "variants-cli-"));
    const file = join(dir, "Launchfile");
    try {
      writeFileSync(file, "name: app\nimage: app\nenv: [private-do-not-echo\n");
      const result = spawnSync("bun", ["run", "inspect", file], { cwd, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("private-do-not-echo");
      expect(result.stderr).toContain("invalid YAML");
    } finally { unlinkSync(file); rmdirSync(dir); }
  });

  it.each([{ args: ["--strict"] }, { args: ["--variant=postgres", "--variant=sqlite"] }, { args: ["--variant="] }])("refuses unsupported arguments $args", ({ args }) => {
    const result = spawnSync("bun", ["run", "inspect", "examples/gitea/Launchfile", ...args], { cwd, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });

  it("accepts caller-supplied unchanged deployment selection in either flag order", () => {
    for (const args of [["--variant=postgres", "--previous-variant=postgres"], ["--previous-variant=postgres", "--variant=postgres"]]) {
      const result = spawnSync("bun", ["run", "inspect", "examples/gitea/Launchfile", ...args], { cwd, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).lifecycle).toEqual({ check: "same-selection", previousSelection: "postgres" });
    }
  });

  it.each([
    { args: ["--previous-variant=baseline", "--variant=postgres"] },
    { args: ["--previous-variant=postgres"] },
  ])("refuses changed deployment selection without a partial preview: $args", ({ args }) => {
    const result = spawnSync("bun", ["run", "inspect", "examples/gitea/Launchfile", ...args], { cwd, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("changing the selected configuration");
  });

  it("represents the existing baseline explicitly without treating it as absent history", () => {
    const result = spawnSync("bun", ["run", "inspect", "examples/gitea/Launchfile", "--previous-variant=baseline"], { cwd, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).lifecycle).toEqual({ check: "same-selection", previousSelection: null });
  });

  it("refuses duplicate previous-selection arguments", () => {
    const result = spawnSync("bun", ["run", "inspect", "examples/gitea/Launchfile", "--previous-variant=baseline", "--previous-variant=postgres"], { cwd, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });
});
