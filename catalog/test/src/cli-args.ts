export class TierArgError extends Error {
  constructor(value: string | undefined) {
    super(`--tier needs a whole number, got: ${value ?? "nothing"}`);
    this.name = "TierArgError";
  }
}

/**
 * Reads `--tier N`, `--tier=N` or the single-argument `"--tier N"` form.
 * Returns undefined when the flag is absent; throws TierArgError when the
 * value is missing or not a whole number.
 */
export function parseTier(args: string[]): number | undefined {
  const index = args.findIndex(
    (a) => a === "--tier" || a.startsWith("--tier=") || a.startsWith("--tier "),
  );
  if (index === -1) return undefined;

  const arg = args[index] as string;
  const value =
    arg === "--tier" ? args[index + 1] : arg.slice("--tier".length + 1);
  if (value === undefined || !/^\d+$/.test(value)) throw new TierArgError(value);
  return Number.parseInt(value, 10);
}
