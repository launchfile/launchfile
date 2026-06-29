import { test, expect } from "@playwright/test";

/**
 * Parameterized mermaid-render test, runnable against either a live site or a
 * locally-served build (`dist/client`). Same two run modes as the search suite:
 * a pre-merge CI run against the freshly-built site, and a post-deploy smoke.
 *
 * It exercises the *whole* diagram path, not just the build output: the page
 * ships `<pre class="mermaid">…</pre>`, and a client script in DocsLayout.astro
 * dynamically imports mermaid from a CDN and renders each one into an `<svg>`.
 * Asserting the `<svg>` actually appears catches the regressions that markup
 * checks miss — e.g. the `__VITE_PRELOAD__` throw that silently killed the
 * dynamic import after the Astro 6→7 bump, or the content-collection mermaid
 * fence never being emitted as `<pre class="mermaid">` in the first place.
 *
 * @param name        display name for the describe block
 * @param baseURL     origin to test (no trailing slash)
 * @param mermaidPath a route known to contain at least one mermaid diagram
 */
export function registerMermaidTests(
  name: string,
  baseURL: string,
  mermaidPath: string,
) {
  const url = (path: string) => baseURL.replace(/\/$/, "") + path;

  test.describe(`${name} mermaid`, () => {
    // The diagram loads mermaid from a CDN at runtime; a transient CDN hiccup
    // shouldn't red the whole pipeline, but a real break (no <svg> ever) still
    // fails after the retries are exhausted.
    test.describe.configure({ retries: 2 });

    test("homepage of the diagram route loads without errors", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));
      await page.goto(url(mermaidPath));
      const real = errors.filter((e) => !e.includes("favicon"));
      expect(real, `Unexpected page errors: ${real.join("; ")}`).toHaveLength(0);
    });

    test(`renders a mermaid diagram on ${mermaidPath}`, async ({ page }) => {
      await page.goto(url(mermaidPath));

      // The build must emit the diagram source as <pre class="mermaid">.
      const source = page.locator("pre.mermaid");
      await expect(source.first()).toBeVisible();

      // The client runner must turn it into a real, sized <svg> — proof the CDN
      // import resolved and mermaid.run() executed against `.mermaid` nodes.
      const svg = page.locator(".mermaid svg").first();
      await expect(svg).toBeVisible({ timeout: 15000 });
      const box = await svg.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(0);
      expect(box?.height ?? 0).toBeGreaterThan(0);
    });
  });
}
