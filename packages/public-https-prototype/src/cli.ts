import { readFile } from "node:fs/promises";
import { planPublicHttps } from "./planner.js";

try {
  const [file, flag, publicUrl, ...extra] = process.argv.slice(2);
  if (!file || flag !== "--public-url" || !publicUrl || extra.length) {
    throw new Error("Usage: bun run plan <Launchfile> --public-url <https://origin>");
  }
  const plan = planPublicHttps(await readFile(file, "utf8"), { publicUrl });
  console.log(JSON.stringify({
    status: plan.status,
    requirements: plan.requirements,
    message: "Planning performed no network operations. A supplied HTTPS URL does not verify a route.",
  }, null, 2));
} catch {
  // YAML and schema errors may quote source values. Keep CLI diagnostics safe
  // even when an unrelated part of the input contains a secret.
  console.error("Public HTTPS planning failed. Check the Launchfile and publication origin.");
  console.error("Usage: bun run plan <Launchfile> --public-url <https://origin>");
  process.exitCode = 1;
}
