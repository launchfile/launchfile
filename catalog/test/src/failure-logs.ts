/**
 * Formats the container logs the harness prints when an app fails its health
 * check. Each compose service gets its own 30-line, 2000-character tail, so a
 * chatty backing service cannot push the app container's lines out of view.
 */

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Run = (cmd: string[]) => Promise<RunResult>;

const TAIL_LINES = "30";
const MAX_CHARS = 2000;
const MAX_STDERR_CHARS = 500;

/** Keeps the last `MAX_CHARS` of `text`, dropping a partial first line when it cuts. */
export function tailText(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const cut = text.slice(-MAX_CHARS);
  const newline = cut.indexOf("\n");
  const whole = newline === -1 ? cut : cut.slice(newline + 1);
  return `…(truncated)\n${whole}`;
}

/** Splits `docker compose config --services` output, keeping compose's order. */
export function parseServices(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function formatServiceLogs(service: string, result: RunResult): string {
  const header = `--- ${service} ---`;
  if (result.exitCode !== 0) {
    return `${header}\nlogs exited ${result.exitCode}: ${result.stderr.slice(-MAX_STDERR_CHARS)}`;
  }
  if (result.stdout.trim().length === 0) {
    return `${header}\n(no output)`;
  }
  return `${header}\n${tailText(result.stdout)}`;
}

/**
 * Returns the full failure-log text. Falls back to one combined
 * `docker compose logs` tail when the service list cannot be read.
 */
export async function collectFailureLogs(run: Run): Promise<string> {
  const lines = ["\n--- Container logs (last 30 lines per service) ---"];

  const config = await run(["docker", "compose", "config", "--services"]);
  const services = config.exitCode === 0 ? parseServices(config.stdout) : [];

  if (services.length === 0) {
    if (config.stderr.length > 0) lines.push(config.stderr);
    const logs = await run(["docker", "compose", "logs", "--tail", TAIL_LINES]);
    lines.push(logs.stdout.slice(-MAX_CHARS));
    return lines.join("\n");
  }

  for (const service of services) {
    const logs = await run(["docker", "compose", "logs", "--no-color", "--tail", TAIL_LINES, service]);
    lines.push(formatServiceLogs(service, logs));
  }
  return lines.join("\n");
}
