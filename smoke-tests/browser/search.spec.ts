import { test, expect } from "@playwright/test";

// Collect console errors during each test
test.beforeEach(async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  // Attach errors to test info for later assertion
  (testInfo as any).__consoleErrors = errors;
});

test.afterEach(async ({}, testInfo) => {
  const errors: string[] = (testInfo as any).__consoleErrors ?? [];
  // Filter out known noise (e.g. favicon 404s, third-party scripts)
  const real = errors.filter(
    (e) =>
      !e.includes("favicon") &&
      !e.includes("the server responded with a status of 404") &&
      !e.includes("Failed to load resource")
  );
  if (real.length > 0) {
    console.log("Console errors:", real);
  }
  expect(real, `Unexpected console errors: ${real.join("; ")}`).toHaveLength(0);
});

test.describe("launchfile.dev", () => {
  test("homepage loads without errors", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Launchfile/i);
  });

  test("search opens with Cmd+K and shows prompt", async ({ page }) => {
    await page.goto("/");

    // Open search dialog
    await page.keyboard.press("Meta+k");
    const dialog = page.locator("#search-dialog");
    await expect(dialog).toBeVisible();

    // Input should be focused
    const input = page.locator("#search-input");
    await expect(input).toBeFocused();

    // Should show initial empty state
    const empty = page.locator("#search-results .search-empty");
    await expect(empty).toContainText("Type to search");
  });

  test("search opens via button click", async ({ page }) => {
    await page.goto("/");

    // Click the search bar
    await page.locator(".docs-search").first().click();
    const dialog = page.locator("#search-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.locator("#search-input")).toBeFocused();
  });

  test("search returns results for a known term", async ({ page }) => {
    await page.goto("/");

    // Open search and type
    await page.keyboard.press("Meta+k");
    const input = page.locator("#search-input");
    await input.fill("validate");

    // Wait for results to appear
    const results = page.locator(".search-result-item");
    await expect(results.first()).toBeVisible({ timeout: 5000 });

    // Should have at least one result
    const count = await results.count();
    expect(count).toBeGreaterThan(0);

    // Results should be links
    const href = await results.first().getAttribute("href");
    expect(href).toBeTruthy();
  });

  test("search shows no-results message for gibberish", async ({ page }) => {
    await page.goto("/");

    await page.keyboard.press("Meta+k");
    await page.locator("#search-input").fill("xyzzyplugh99");

    // Wait for the no-results message
    const empty = page.locator("#search-results .search-empty");
    await expect(empty).toBeVisible({ timeout: 5000 });
    await expect(empty).toContainText("No results for");
  });

  test("search closes with Escape", async ({ page }) => {
    await page.goto("/");

    await page.keyboard.press("Meta+k");
    await expect(page.locator("#search-dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("#search-dialog")).not.toBeVisible();
  });

  test("clicking a result navigates and closes dialog", async ({ page }) => {
    await page.goto("/");

    await page.keyboard.press("Meta+k");
    await page.locator("#search-input").fill("runtime");

    const firstResult = page.locator(".search-result-item").first();
    await expect(firstResult).toBeVisible({ timeout: 5000 });

    const href = await firstResult.getAttribute("href");
    await firstResult.click();

    // Dialog should close
    await expect(page.locator("#search-dialog")).not.toBeVisible();

    // Should have navigated (URL changed or page loaded)
    if (href) {
      await expect(page).toHaveURL(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});

test.describe("launchfile.org", () => {
  test("homepage loads without errors", async ({ page }) => {
    await page.goto("https://launchfile.org/");
    await expect(page).toHaveTitle(/Launchfile/i);
  });

  test("search works on spec site", async ({ page }) => {
    await page.goto("https://launchfile.org/");

    await page.keyboard.press("Meta+k");
    const dialog = page.locator("#search-dialog");
    await expect(dialog).toBeVisible();

    await page.locator("#search-input").fill("components");

    const results = page.locator(".search-result-item");
    await expect(results.first()).toBeVisible({ timeout: 5000 });
    expect(await results.count()).toBeGreaterThan(0);
  });
});
