import { describe, expect, it } from "vitest";
import { parseTier, TierArgError } from "./cli-args.ts";

describe("parseTier", () => {
  it.each([
    [[]],
    [["--dry-run"]],
    [["--url", "x"]],
    [["--url=x"]],
  ])("returns undefined without --tier: %j", (args) => {
    expect(parseTier(args)).toBeUndefined();
  });

  it.each([
    [["--tier", "2"]],
    [["--tier=2"]],
    [["--tier 2"]],
    [["--dry-run", "--tier", "2"]],
  ])("reads the tier from %j", (args) => {
    expect(parseTier(args)).toBe(2);
  });

  it("accepts tier 0", () => {
    expect(parseTier(["--tier", "0"])).toBe(0);
  });

  it.each([
    [["--tier"], "nothing"],
    [["--tier", "--dry-run"], "--dry-run"],
    [["--tier", "abc"], "abc"],
    [["--tier=abc"], "abc"],
    [["--tier="], ""],
    [["--tier", "2x"], "2x"],
  ])("throws for %j", (args, got) => {
    expect(() => parseTier(args)).toThrow(TierArgError);
    expect(() => parseTier(args)).toThrow(`--tier needs a whole number, got: ${got}`);
  });
});
