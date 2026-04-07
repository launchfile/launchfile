/**
 * Smoke tests for the @launchfile/sdk programmatic API.
 * Plain ESM — runs on Node 18+ and Bun without compilation.
 */

import {
  readLaunch,
  writeLaunch,
  isExpression,
  LaunchSchema,
} from "@launchfile/sdk";

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

const dbYaml = `\
version: launch/v1
name: my-app
runtime: node
requires: [postgres]
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

console.log("  --- @launchfile/sdk API tests ---");

// C1: readLaunch parses minimal
const minimal = readLaunch(minimalYaml);
assert("C1: readLaunch returns correct name", minimal.name === "my-api");

// C2: readLaunch produces components.default
assert(
  "C2: readLaunch has components.default",
  minimal.components && "default" in minimal.components
);

// C3: readLaunch parses requires
const withDb = readLaunch(dbYaml);
assert(
  "C3: readLaunch parses postgres requirement",
  withDb.components.default.requires?.[0]?.type === "postgres"
);

// C4: readLaunch rejects invalid
assertThrows("C4: readLaunch throws on invalid input", () => {
  readLaunch(invalidYaml);
});

// C5: round-trip preserves structure
const written = writeLaunch(minimal);
const roundTripped = readLaunch(written);
assert(
  "C5: round-trip preserves name",
  roundTripped.name === minimal.name
);

// C6: isExpression detects $ references
assert("C6: isExpression('$host') is true", isExpression("$host") === true);

// C7: isExpression rejects plain strings
assert(
  "C7: isExpression('hello') is false",
  isExpression("hello") === false
);

// C8: LaunchSchema is exported
assert("C8: LaunchSchema is truthy", !!LaunchSchema);

// --- Summary ---

console.log(`\n  @launchfile/sdk API: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
