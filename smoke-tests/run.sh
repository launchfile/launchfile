#!/usr/bin/env bash
#
# Smoke tests for the Launchfile SDK, CLI, and websites.
# Runs in a clean temp directory to simulate a new user's experience.
#
# Usage:
#   bash smoke-tests/run.sh                   # Run all tests
#   bash smoke-tests/run.sh --websites-only   # Only website checks
#   bash smoke-tests/run.sh --skip-websites   # Skip website checks
#   bash smoke-tests/run.sh --skip-bun        # Skip bun-specific tests
#
# Environment:
#   SMOKE_TEST_VERSION  Package version to test (default: "latest")
#

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="${SMOKE_TEST_VERSION:-latest}"

# --- Flags ---
WEBSITES_ONLY=false
SKIP_WEBSITES=false
SKIP_BUN=false

for arg in "$@"; do
  case "$arg" in
    --websites-only) WEBSITES_ONLY=true ;;
    --skip-websites) SKIP_WEBSITES=true ;;
    --skip-bun)      SKIP_BUN=true ;;
    *) echo "Unknown flag: $arg"; exit 2 ;;
  esac
done

# --- Counters ---
PASS=0
FAIL=0
WARN=0
SKIP=0

pass() { PASS=$((PASS + 1)); echo "  PASS  $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }
warn() { WARN=$((WARN + 1)); echo "  WARN  $1"; }
skip() { SKIP=$((SKIP + 1)); echo "  SKIP  $1"; }

# --- Temp directory ---
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
echo "=== Launchfile Smoke Tests ==="
echo "Package version: $VERSION"
echo "Working directory: $WORKDIR"
echo ""

# ============================================================================
# Category D: Website Smoke Tests
# ============================================================================

run_website_tests() {
  echo "=== D: Website Smoke Tests ==="
  local start=$SECONDS

  # D1: launchfile.dev is up
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://launchfile.dev 2>/dev/null)
  if [ "$status" = "200" ]; then pass "D1: launchfile.dev returns 200"
  else fail "D1: launchfile.dev returned $status (expected 200)"; fi

  # D2: launchfile.org is up
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://launchfile.org 2>/dev/null)
  if [ "$status" = "200" ]; then pass "D2: launchfile.org returns 200"
  else fail "D2: launchfile.org returned $status (expected 200)"; fi

  # D3: Dev site has content
  local body
  body=$(curl -s --max-time 10 https://launchfile.dev 2>/dev/null)
  if echo "$body" | grep -qi "launchfile"; then pass "D3: launchfile.dev contains 'Launchfile'"
  else fail "D3: launchfile.dev body missing 'Launchfile'"; fi

  # D4: Org site has content
  body=$(curl -s --max-time 10 https://launchfile.org 2>/dev/null)
  if echo "$body" | grep -qi "launchfile"; then pass "D4: launchfile.org contains 'Launchfile'"
  else fail "D4: launchfile.org body missing 'Launchfile'"; fi

  # D5: Schema URL serves JSON (for editor integration: yaml-language-server)
  local ctype schema_body
  ctype=$(curl -s -o /dev/null -w "%{content_type}" --max-time 10 https://launchfile.dev/schema/v1 2>/dev/null)
  schema_body=$(curl -s --max-time 10 https://launchfile.dev/schema/v1 2>/dev/null)
  if echo "$schema_body" | grep -q '"title": "Launchfile"'; then pass "D5: schema/v1 serves JSON Schema"
  else fail "D5: schema/v1 does not serve JSON Schema (content-type: '$ctype')"; fi

  echo "  ($(( SECONDS - start ))s)"
  echo ""
}

# ============================================================================
# Category A: Package Installation
# ============================================================================

run_install_tests() {
  echo "=== A: Package Installation ==="
  local start=$SECONDS

  local NPM_DIR="$WORKDIR/npm-test"
  local BUN_DIR="$WORKDIR/bun-test"
  mkdir -p "$NPM_DIR" "$BUN_DIR"

  # npm installs
  cd "$NPM_DIR"
  echo '{"type":"module","private":true}' > package.json

  local pkg_sdk="@launchfile/sdk"
  local pkg_redirect="launchfile"
  if [ "$VERSION" != "latest" ]; then
    pkg_sdk="@launchfile/sdk@$VERSION"
    pkg_redirect="launchfile@$VERSION"
  fi

  if npm install "$pkg_sdk" --silent 2>&1 >/dev/null; then
    if [ -f node_modules/@launchfile/sdk/dist/cli.js ]; then
      pass "A1: npm install @launchfile/sdk"
    else
      fail "A1: npm install @launchfile/sdk (missing dist/cli.js)"
    fi
  else
    fail "A1: npm install @launchfile/sdk (exit non-zero)"
  fi

  if npm install "$pkg_redirect" --silent 2>&1 >/dev/null; then
    if [ -d node_modules/@launchfile/sdk ]; then
      pass "A2: npm install launchfile (transitive @launchfile/sdk present)"
    else
      fail "A2: npm install launchfile (missing transitive @launchfile/sdk)"
    fi
  else
    fail "A2: npm install launchfile (exit non-zero)"
  fi

  # bun installs
  if [ "$SKIP_BUN" = true ]; then
    skip "A3: bun add @launchfile/sdk (--skip-bun)"
    skip "A4: bun add launchfile (--skip-bun)"
  else
    cd "$BUN_DIR"
    echo '{"type":"module","private":true}' > package.json

    if bun add "$pkg_sdk" 2>&1 >/dev/null; then
      pass "A3: bun add @launchfile/sdk"
    else
      fail "A3: bun add @launchfile/sdk (exit non-zero)"
    fi

    if bun add "$pkg_redirect" 2>&1 >/dev/null; then
      pass "A4: bun add launchfile"
    else
      fail "A4: bun add launchfile (exit non-zero)"
    fi
  fi

  echo "  ($(( SECONDS - start ))s)"
  echo ""
}

# ============================================================================
# Category B: CLI Commands
# ============================================================================

run_cli_tests() {
  echo "=== B: CLI Commands ==="
  local start=$SECONDS

  local NPM_DIR="$WORKDIR/npm-test"
  cd "$NPM_DIR"

  # Copy fixtures into working directory
  cp "$SCRIPT_DIR/fixtures/"* "$NPM_DIR/"

  local out rc

  # B1: --version
  out=$(npx launchfile --version 2>&1) ; rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q "0.1."; then pass "B1: --version"
  else fail "B1: --version (rc=$rc, out='$out')"; fi

  # B2: --help
  out=$(npx launchfile --help 2>&1) ; rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q "validate" && echo "$out" | grep -q "inspect" && echo "$out" | grep -q "schema"; then
    pass "B2: --help shows commands"
  else fail "B2: --help (rc=$rc)"; fi

  # B3: validate minimal
  out=$(npx launchfile validate minimal.yaml --no-color 2>&1) ; rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q "is valid"; then pass "B3: validate minimal"
  else fail "B3: validate minimal (rc=$rc, out='$out')"; fi

  # B4: validate minimal-with-db (check postgres mentioned)
  out=$(npx launchfile validate minimal-with-db.yaml --no-color 2>&1) ; rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q "postgres"; then pass "B4: validate minimal-with-db shows postgres"
  else fail "B4: validate minimal-with-db (rc=$rc, out='$out')"; fi

  # B5: validate multi-component
  out=$(npx launchfile validate multi-component.yaml --no-color 2>&1) ; rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q "is valid"; then pass "B5: validate multi-component"
  else fail "B5: validate multi-component (rc=$rc, out='$out')"; fi

  # B6: validate --json
  out=$(npx launchfile validate minimal.yaml --json 2>&1) ; rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q '"valid": true'; then pass "B6: validate --json"
  else fail "B6: validate --json (rc=$rc, out='$out')"; fi

  # B7: validate --quiet (stdout should be empty)
  out=$(npx launchfile validate minimal.yaml --quiet 2>&1) ; rc=$?
  if [ $rc -eq 0 ] && [ -z "$out" ]; then pass "B7: validate --quiet (silent, exit 0)"
  else fail "B7: validate --quiet (rc=$rc, out='$out')"; fi

  # B8: validate invalid file
  out=$(npx launchfile validate invalid.yaml --no-color 2>&1) ; rc=$?
  if [ $rc -ne 0 ]; then pass "B8: validate invalid exits non-zero"
  else fail "B8: validate invalid (expected exit 1, got 0)"; fi

  # B9: validate invalid --quiet
  out=$(npx launchfile validate invalid.yaml --quiet 2>/dev/null) ; rc=$?
  if [ $rc -ne 0 ] && [ -z "$out" ]; then pass "B9: validate invalid --quiet (silent, exit 1)"
  else fail "B9: validate invalid --quiet (rc=$rc, out='$out')"; fi

  # B10: validate invalid --json
  out=$(npx launchfile validate invalid.yaml --json 2>&1) ; rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -q '"valid": false'; then pass "B10: validate invalid --json"
  else fail "B10: validate invalid --json (rc=$rc, out='$out')"; fi

  # B11: inspect minimal
  out=$(npx launchfile inspect minimal.yaml 2>&1) ; rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q '"name": "my-api"'; then pass "B11: inspect outputs JSON"
  else fail "B11: inspect (rc=$rc, out='$out')"; fi

  # B12: validate nonexistent file
  out=$(npx launchfile validate nonexistent.yaml 2>&1) ; rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -qi "not found"; then pass "B12: validate missing file"
  else fail "B12: validate missing file (rc=$rc, out='$out')"; fi

  # B13: no args shows help
  out=$(npx launchfile 2>&1) ; rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -q "validate"; then pass "B13: no args shows help"
  else fail "B13: no args (rc=$rc)"; fi

  # B14: schema command (dumps JSON Schema to stdout)
  out=$(npx launchfile schema 2>&1) ; rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q '"title": "Launchfile"'; then pass "B14: schema command outputs JSON Schema"
  else fail "B14: schema command (rc=$rc)"; fi

  # B15-B16: bun tests
  if [ "$SKIP_BUN" = true ]; then
    skip "B15: bunx --version (--skip-bun)"
    skip "B16: bunx validate (--skip-bun)"
  else
    local BUN_DIR="$WORKDIR/bun-test"
    cp "$SCRIPT_DIR/fixtures/"* "$BUN_DIR/"
    cd "$BUN_DIR"

    out=$(bunx launchfile --version 2>&1) ; rc=$?
    if [ $rc -eq 0 ] && echo "$out" | grep -q "0.1."; then pass "B15: bunx --version"
    else fail "B15: bunx --version (rc=$rc, out='$out')"; fi

    out=$(bunx launchfile validate minimal.yaml --no-color 2>&1) ; rc=$?
    if [ $rc -eq 0 ] && echo "$out" | grep -q "is valid"; then pass "B16: bunx validate"
    else fail "B16: bunx validate (rc=$rc, out='$out')"; fi
  fi

  echo "  ($(( SECONDS - start ))s)"
  echo ""
}

# ============================================================================
# Category C: Programmatic API
# ============================================================================

run_api_tests() {
  echo "=== C: Programmatic API ==="
  local start=$SECONDS

  local NPM_DIR="$WORKDIR/npm-test"
  cd "$NPM_DIR"

  # Copy test files
  cp "$SCRIPT_DIR/test-api.mjs" "$NPM_DIR/"
  cp "$SCRIPT_DIR/test-api-redirect.mjs" "$NPM_DIR/"

  # Run with Node.js
  if node test-api.mjs; then
    pass "C: @launchfile/sdk API tests (node)"
  else
    fail "C: @launchfile/sdk API tests (node)"
  fi

  if node test-api-redirect.mjs; then
    pass "C: launchfile redirect API tests (node)"
  else
    fail "C: launchfile redirect API tests (node)"
  fi

  # Run with Bun
  if [ "$SKIP_BUN" = true ]; then
    skip "C: @launchfile/sdk API tests (bun) (--skip-bun)"
    skip "C: launchfile redirect API tests (bun) (--skip-bun)"
  else
    local BUN_DIR="$WORKDIR/bun-test"
    cp "$SCRIPT_DIR/test-api.mjs" "$BUN_DIR/"
    cp "$SCRIPT_DIR/test-api-redirect.mjs" "$BUN_DIR/"
    cd "$BUN_DIR"

    if bun run test-api.mjs; then
      pass "C: @launchfile/sdk API tests (bun)"
    else
      fail "C: @launchfile/sdk API tests (bun)"
    fi

    if bun run test-api-redirect.mjs; then
      pass "C: launchfile redirect API tests (bun)"
    else
      fail "C: launchfile redirect API tests (bun)"
    fi
  fi

  echo "  ($(( SECONDS - start ))s)"
  echo ""
}

# ============================================================================
# Run
# ============================================================================

TOTAL_START=$SECONDS

if [ "$WEBSITES_ONLY" = true ]; then
  run_website_tests
else
  run_install_tests
  run_cli_tests
  run_api_tests
  if [ "$SKIP_WEBSITES" = false ]; then
    run_website_tests
  fi
fi

# ============================================================================
# Summary
# ============================================================================

echo "=== Summary ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  WARN: $WARN"
echo "  SKIP: $SKIP"
echo "  Time: $(( SECONDS - TOTAL_START ))s"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "RESULT: FAILED"
  exit 1
else
  echo "RESULT: PASSED"
  exit 0
fi
