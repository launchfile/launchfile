import { readVariants, redactPreview } from "./variants.js";

try {
  const args = Bun.argv.slice(2);
  const file = args.shift();
  if (!file || file.startsWith("-") || args.length > 1 || (args.length === 1 && !/^--variant=[a-z][a-z0-9-]*$/.test(args[0]!))) {
    throw new Error("Usage: bun run inspect <Launchfile> [--variant=<name>]");
  }
  const preview = readVariants(await Bun.file(file).text(), args[0]?.slice("--variant=".length));
  process.stdout.write(JSON.stringify({ experimental: true, ...redactPreview(preview) }, null, 2) + "\n");
} catch (error) {
  process.stderr.write(`variants-prototype: ${error instanceof Error ? error.message : "preview failed"}\n`);
  process.exitCode = 1;
}
