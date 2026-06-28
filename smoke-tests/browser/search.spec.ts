import { registerSearchTests } from "./search-tests";

// Two run modes:
//
// 1. Post-deploy smoke (default — no env): test the live sites.
// 2. Pre-merge CI (SEARCH_BASE_URL set): test ONE locally-served build
//    (`<site>/dist/client`), so a search regression fails the PR before it can
//    ship. Driven by the `websites` job in .github/workflows/ci.yml.
const localBase = process.env.SEARCH_BASE_URL;

if (localBase) {
  registerSearchTests(
    process.env.SEARCH_SITE ?? "local build",
    localBase,
    process.env.SEARCH_TERM ?? "launchfile",
  );
} else {
  registerSearchTests("launchfile.dev", "https://launchfile.dev", "validate");
  registerSearchTests("launchfile.org", "https://launchfile.org", "components");
}
