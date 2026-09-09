import { readVariants, redactPreview, type SelectionContext } from "./variants.js";

try {
  const args = Bun.argv.slice(2);
  const file = args.shift();
  const usage = "Usage: bun run inspect <Launchfile> [--variant=<name>] [--previous-variant=<name|baseline>]";
  if (!file || file.startsWith("-") || args.length > 2) throw new Error(usage);
  const flags = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(variant|previous-variant)=([a-z][a-z0-9-]*)$/.exec(arg);
    if (!match || flags.has(match[1]!)) throw new Error(usage);
    flags.set(match[1]!, match[2]!);
  }
  const context: SelectionContext = {};
  if (flags.has("previous-variant")) {
    const previous = flags.get("previous-variant")!;
    context.previousSelection = previous === "baseline" ? null : previous;
  }
  const preview = readVariants(await Bun.file(file).text(), flags.get("variant"), context);
  process.stdout.write(JSON.stringify({ experimental: true, ...redactPreview(preview) }, null, 2) + "\n");
} catch (error) {
  process.stderr.write(`variants-prototype: ${error instanceof Error ? error.message : "preview failed"}\n`);
  process.exitCode = 1;
}
