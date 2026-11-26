import { defineConfig } from "@playwright/test";

// Viewport tests run against the production build, in the browser already installed on the machine
// (Edge by default; set PW_CHANNEL=chrome to use Chrome).
export default defineConfig({
  testDir: "tests",
  testMatch: /.*\.pw\.ts/,
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:4173", channel: process.env.PW_CHANNEL ?? "msedge" },
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
