import { describe, expect, it } from "vitest";
import { skipsForHttpsOrigin } from "./https-origin-skip.ts";

describe("skipsForHttpsOrigin", () => {
  it("skips an https-origin app when --url is absent", () => {
    expect(skipsForHttpsOrigin(true, undefined)).toBe(true);
  });

  it("skips an https-origin app when --url is http", () => {
    expect(skipsForHttpsOrigin(true, "http://x.example")).toBe(true);
  });

  it("runs an https-origin app when --url is https", () => {
    expect(skipsForHttpsOrigin(true, "https://x.example")).toBe(false);
  });

  it("runs an https-origin app when the scheme is uppercase", () => {
    expect(skipsForHttpsOrigin(true, "HTTPS://x.example")).toBe(false);
  });

  it("does not skip a malformed --url, so test-app.ts reports the refusal", () => {
    expect(skipsForHttpsOrigin(true, "notaurl")).toBe(false);
  });

  it("never skips an app without the requirement", () => {
    expect(skipsForHttpsOrigin(false, undefined)).toBe(false);
  });
});
