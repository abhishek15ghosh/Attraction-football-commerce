const { defineConfig } = require("@playwright/test");

const explicitBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = explicitBaseURL || "http://127.0.0.1:4174";

const config = {
  testDir: "./tests",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  reporter: [["list"]],
  use: {
    baseURL,
    browserName: "chromium",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    actionTimeout: 10_000,
  },
};

if (!explicitBaseURL) {
  config.webServer = {
    command: "python3 -m http.server 4174 --bind 127.0.0.1",
    url: baseURL,
    cwd: process.cwd(),
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  };
}

module.exports = defineConfig(config);
