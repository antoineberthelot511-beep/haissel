/*
 * Tests de bout en bout (npm run test:e2e) : WebKit en émulation iPhone 13,
 * serveur local sur un schéma de test jetable (tests/e2e/server.js).
 * `npm test` (Jest) ne lance aucun navigateur.
 */
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 4317);

module.exports = defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.js',
  timeout: 30000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [
    { name: 'iphone-webkit', use: { ...devices['iPhone 13'], hasTouch: true, browserName: 'webkit' } },
  ],
  webServer: {
    command: 'node tests/e2e/server.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 60000,
  },
});
