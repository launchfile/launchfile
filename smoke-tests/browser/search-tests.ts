import { test, expect, type Page } from "@playwright/test";

/**
 * Parameterized search test suite, runnable against either a live site or a
 * locally-served build (`dist/client`). The same assertions guard:
 *   - the post-deploy smoke run (live launchfile.dev / launchfile.org), and
 *   - the pre-merge CI run against each site's freshly-built output.
 *
 * The pre-merge run is the one that matters here: site search broke for ~6 days
 * after the Astro 6→7 bump because nothing exercised it before deploy — only the
 * post-deploy smoke caught it, against an already-live regression.
 *
 * @param name      display name for the describe block
 * @param baseURL   origin to test (no trailing slash), e.g. "https://launchfile.dev" or "http://localhost:8080"
 * @param knownTerm a word known to be indexed on this site (returns >0 results)
 */
export function registerSearchTests(name: string, baseURL: string, knownTerm: string) {
  const url = (path: string) => baseURL.replace(/\/$/, "") + path;

  test.describe(name, () => {
    // Fail on unexpected console errors — a silent throw in the search code
    // (e.g. the __VITE_PRELOAD__ regression) must not pass unnoticed.
    test.beforeEach(async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      page.on("pageerror", (err) => errors.push(err.message));
      (testInfo as unknown as { __consoleErrors: string[] }).__consoleErrors = errors;
    });

    test.afterEach(async ({}, testInfo) => {
      const errors: string[] = (testInfo as unknown as { __consoleErrors?: string[] }).__consoleErrors ?? [];
      const real = errors.filter(
        (e) =>
          !e.includes("favicon") &&
          !e.includes("the server responded with a status of 404") &&
          !e.includes("Failed to load resource"),
      );
      expect(real, `Unexpected console errors: ${real.join("; ")}`).toHaveLength(0);
    });

    test("homepage loads without errors", async ({ page }) => {
      await page.goto(url("/"));
      await expect(page).toHaveTitle(/Launchfile/i);
    });

    test("search opens with Cmd+K and shows prompt", async ({ page }) => {
      await page.goto(url("/"));
      await page.keyboard.press("Meta+k");
      await expect(page.locator("#search-dialog")).toBeVisible();
      await expect(page.locator("#search-input")).toBeFocused();
      await expect(page.locator("#search-results .search-empty")).toContainText("Type to search");
    });

    test("search returns results for a known term", async ({ page }) => {
      await page.goto(url("/"));
      await page.keyboard.press("Meta+k");
      await page.locator("#search-input").fill(knownTerm);
      const results = page.locator(".search-result-item");
      await expect(results.first()).toBeVisible({ timeout: 5000 });
      expect(await results.count()).toBeGreaterThan(0);
      expect(await results.first().getAttribute("href")).toBeTruthy();
    });

    test("search executes for an unlikely term without the 'unavailable' error", async ({ page }) => {
      await page.goto(url("/"));
      await page.keyboard.press("Meta+k");
      await page.locator("#search-input").fill("qzxwk-plughyyz-zzqq");
      // The regression showed "Search is not available right now" for *every*
      // query (the dynamic import threw). The robust guard is content-agnostic:
      // whatever an unlikely term happens to match, search must EXECUTE — never
      // the error state, and it must move past the initial "Type to search"
      // prompt to a definite response (results, or a "No results" message).
      const results = page.locator("#search-results");
      await expect(results).not.toContainText("not available", { timeout: 8000 });
      await expect(results).not.toContainText("Type to search", { timeout: 8000 });
      await expect(
        page.locator(".search-result-item").first().or(results.locator(".search-empty")),
      ).toBeVisible({ timeout: 8000 });
    });

    test("search closes with Escape", async ({ page }) => {
      await page.goto(url("/"));
      await page.keyboard.press("Meta+k");
      await expect(page.locator("#search-dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("#search-dialog")).not.toBeVisible();
    });

    test("clicking a result navigates and closes dialog", async ({ page }: { page: Page }) => {
      await page.goto(url("/"));
      await page.keyboard.press("Meta+k");
      await page.locator("#search-input").fill(knownTerm);
      const firstResult = page.locator(".search-result-item").first();
      await expect(firstResult).toBeVisible({ timeout: 5000 });
      const href = await firstResult.getAttribute("href");
      await firstResult.click();
      await expect(page.locator("#search-dialog")).not.toBeVisible();
      if (href) {
        await expect(page).toHaveURL(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    });
  });
}
