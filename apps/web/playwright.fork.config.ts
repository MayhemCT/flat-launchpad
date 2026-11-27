import { defineConfig } from "@playwright/test";

// For the tests that run the pages against a local fork of BNB Chain (tests/rooms.pw.ts, fees.pw.ts,
// launch.pw.ts, trade.pw.ts): the site is served by `wrangler dev` on port 8788, built with VITE_BSC_RPC_URL
// set to the fork. The page's connect-src policy names the public BNB Chain endpoints only, so it is lifted
// here to let the page reach the fork; nothing else about the page changes.
export default defineConfig({
  testDir: "tests",
  testMatch: /.*\.pw\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.API_ORIGIN ?? "http://localhost:8788", channel: process.env.PW_CHANNEL ?? "msedge", bypassCSP: true, screenshot: "only-on-failure" },
});
