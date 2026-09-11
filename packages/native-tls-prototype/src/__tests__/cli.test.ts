import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const execute = promisify(execFile);
const cwd = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  }
});

describe("prototype CLI", () => {
  test("does not print malformed YAML source containing a secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tls-prototype-secret-"));
    directories.push(directory);
    const file = join(directory, "Launchfile");
    await writeFile(file, 'name: test\nimage: nginx\nenv:\n  API_TOKEN: "secret-sentinel-never-print\n');
    const result = await execute("bun", ["src/cli.ts", file], { cwd }).catch(error => error);
    expect(result.stderr).toContain("Invalid Launchfile YAML");
    expect(`${result.stdout}${result.stderr}`).not.toContain("secret-sentinel-never-print");
  });

  test("prints an honest public/listener plan without claiming deployment", async () => {
    const { stdout } = await execute("bun", ["src/cli.ts", "examples/gitea/Launchfile", "--tls=edge", "--url=https://localhost:3443", "--json"], { cwd });
    expect(JSON.parse(stdout)).toMatchObject({ listener: "http:3000", publicUrl: "https://localhost:3443", certificate: null, status: "planned; material and routing not verified" });
  });
  test("creates Compose privately and refuses to overwrite an existing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tls-prototype-cli-"));
    directories.push(directory);
    const artifact = join(directory, "compose.yaml");
    const args = ["src/cli.ts", "examples/gitea/Launchfile", "--compose-file", artifact];
    await execute("bun", args, { cwd });
    expect((await stat(artifact)).mode & 0o777).toBe(0o600);
    await writeFile(artifact, "existing user content");
    await expect(execute("bun", args, { cwd })).rejects.toThrow();
    expect(await readFile(artifact, "utf8")).toBe("existing user content");
  });
});
