/**
 * Smoke tests for the "launchfile" redirect package.
 * Identical to test-api.mjs but imports from "launchfile" instead of "@launchfile/sdk".
 * Verifies that the convenience package re-exports everything correctly.
 */

import {
  readLaunch,
  writeLaunch,
  isExpression,
  LaunchSchema,
} from "launchfile";

let pass = 0;
let fail = 0;

function assert(name, condition) {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
}

function assertThrows(name, fn) {
  try {
    fn();
    fail++;
    console.log(`  FAIL  ${name} (expected throw, got none)`);
  } catch {
    pass++;
    console.log(`  PASS  ${name}`);
  }
}

// --- Fixtures ---

const minimalYaml = `\
version: launch/v1
name: my-api
runtime: node
commands:
  start: "node server.js"
`;

const invalidYaml = `\
version: launch/v1
runtime: 12345
commands:
  start: 123
`;

// --- Tests ---

console.log("  --- launchfile (redirect) API tests ---");

const minimal = readLaunch(minimalYaml);
assert("R1: readLaunch returns correct name", minimal.name === "my-api");
assert(
  "R2: readLaunch has components.default",
  minimal.components && "default" in minimal.components
);

assertThrows("R3: readLaunch throws on invalid input", () => {
  readLaunch(invalidYaml);
});

const written = writeLaunch(minimal);
const roundTripped = readLaunch(written);
assert("R4: round-trip preserves name", roundTripped.name === minimal.name);

assert("R5: isExpression works via redirect", isExpression("$host") === true);
assert("R6: LaunchSchema exported via redirect", !!LaunchSchema);

// --- Summary ---

console.log(`\n  launchfile (redirect) API: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
