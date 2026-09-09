import { expect, it } from "bun:test";
import { readLaunch } from "@launchfile/sdk";
import { ForeignProposalError, readStrictnessLaunch } from "../src/input.js";

const baseline = "name: experiment\nimage: example/app\nschedule: '0 0 * * *'\n";
it("preserves canonical parsing for ordinary Launchfiles", () => {
  expect(readStrictnessLaunch(baseline)).toEqual(readLaunch(baseline));
});
it.each([
  "variants: {}",
  "tls: false",
  "public: {}",
  "provides:\n  - protocol: http\n    port: 3000\n    tls: certificate",
  "requires:\n  - type: certificate\n    name: server-cert",
  "supports:\n  - certificate",
  "requires:\n  - type: postgres\n    public: { scheme: https }",
  "supports:\n  - public: { endpoint: web, scheme: https }",
])("refuses foreign proposal marker before normalization: %s", (suffix) => {
  expect(() => readStrictnessLaunch(`${baseline}${suffix}\n`)).toThrow(ForeignProposalError);
});
it.each([
  "variants: {}", "tls: false", "public: {}",
  "provides:\n  - protocol: http\n    port: 3000\n    tls: server-cert",
  "requires:\n  - type: certificate",
  "supports:\n  - public: { endpoint: web, scheme: https }",
])("refuses component-scoped foreign proposal marker: %s", (suffix) => {
  const nested = suffix.split("\n").map((line) => `    ${line}`).join("\n");
  expect(() => readStrictnessLaunch(`name: multi\ncomponents:\n  web:\n    image: example/app\n${nested}\n`)).toThrow(ForeignProposalError);
});
it("does not become a generic unknown-field validator", () => {
  expect(readStrictnessLaunch(`${baseline}custom_annotation: harmless\n`)).toEqual(readLaunch(baseline));
});
