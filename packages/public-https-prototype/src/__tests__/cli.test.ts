import { execFile } from "node:child_process";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const cwd = new URL("../../", import.meta.url).pathname;

it("prints only an unresolved plan from the real CLI", async () => {
  const result = await execute("bun", ["run", "plan", "examples/Launchfile", "--public-url", "https://app.example"], { cwd });
  const output = JSON.parse(result.stdout);
  expect(output.status).toBe("unresolved");
  expect(output.requirements[0].endpoint).toBe("web");
  expect(output.launch).toBeUndefined();
});

it.each([
  "name: broken\nenv:\n  TOKEN: [SECRET_SENTINEL,\n",
  "name: SECRET_SENTINEL\nprovides: [{ port: SECRET_SENTINEL }]\n",
])("does not quote secret-bearing YAML or schema failures", async (file) => {
  const directory = await mkdtemp(join(tmpdir(), "launchfile-public-https-cli-"));
  const path = join(directory, "Launchfile");
  await writeFile(path, file, { mode: 0o600 });
  try {
    const result = await execute("bun", ["run", "plan", path, "--public-url", "https://app.example"], { cwd })
      .then(() => { throw new Error("Expected CLI failure"); }, (error: { stdout: string; stderr: string; code: number }) => error);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Public HTTPS planning failed");
    expect(result.stdout + result.stderr).not.toContain("SECRET_SENTINEL");
  } finally {
    await unlink(path);
    await rmdir(directory);
  }
});
