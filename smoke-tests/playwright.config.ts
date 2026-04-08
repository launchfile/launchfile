import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: "https://launchfile.dev",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
