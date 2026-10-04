import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a running deployment with at least one subscription, e.g. the Docker
 * stack: E2E_BASE_URL, E2E_LOGIN, and E2E_PASSWORD select it.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'mobile-safari', use: { ...devices['iPhone 15'] }, grep: /@mobile/ },
  ],
});
