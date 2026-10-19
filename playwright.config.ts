import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: existsSync("/usr/bin/chromium")
          ? { executablePath: "/usr/bin/chromium" }
          : {},
      },
    },
    {
      name: "webkit-mobile",
      testMatch: [
        "mobile.spec.ts",
        "length-layout.spec.ts",
        "navigation.spec.ts",
        "provider-settings.spec.ts",
        "request-budget.spec.ts",
        "plugins.spec.ts",
        "comparison.spec.ts",
        "plugin-settings.spec.ts",
        "summaries.spec.ts",
        "appearance.spec.ts",
        "account-usage.spec.ts",
        "stream-follow.spec.ts",
        "auth-security.spec.ts",
      ],
      use: { browserName: "webkit" },
    },
  ],
  webServer: {
    command: "node scripts/dev-init.mjs && npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
