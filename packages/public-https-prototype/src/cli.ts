import { readFile } from "node:fs/promises";
import { planPublicHttps, type PublicHttpsOptions } from "./planner.js";

const usage = "Usage: bun run plan <Launchfile> [--public-url <origin> | --publication=no-channel|after-apply] [--mode=translate]";

try {
  const [file, ...args] = process.argv.slice(2);
  if (!file || file.startsWith("--")) throw new Error(usage);
  const options: PublicHttpsOptions = {};
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const key = arg.split("=")[0]!;
    if (seen.has(key)) throw new Error(usage);
    seen.add(key);
    if (arg === "--public-url" && args[index + 1] !== undefined) options.publicUrl = args[++index];
    else if (arg === "--publication=no-channel") options.publication = "no-channel";
    else if (arg === "--publication=after-apply") options.publication = "after-apply";
    else if (arg === "--mode=translate") options.mode = "translate";
    else throw new Error(usage);
  }
  const plan = planPublicHttps(await readFile(file, "utf8"), options);
  console.log(JSON.stringify({
    status: plan.status,
    requirements: plan.requirements,
    message: "Planning performed no network operations. A supplied HTTPS URL does not verify a route.",
  }, null, 2));
} catch {
  // YAML and schema errors may quote source values. Keep CLI diagnostics safe
  // even when an unrelated part of the input contains a secret.
  console.error("Public HTTPS planning failed. Check the Launchfile and publication origin.");
  console.error(usage);
  process.exitCode = 1;
}
