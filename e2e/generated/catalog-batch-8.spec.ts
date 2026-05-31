
/**
 * Auto-generated app catalog tests for server batch 8
 * Generated: 2026-05-31T17:54:12.917Z
 * Apps: 13
 */

import { expect, installApp, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    "id": "postiz",
    "storeSlug": "ci-apps",
    "name": "Postiz",
    "expectedPort": 8921,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low"
  },
  {
    "id": "prestashop",
    "storeSlug": "ci-apps",
    "name": "PrestaShop",
    "expectedPort": 8923,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low"
  },
  {
    "id": "prometheus",
    "storeSlug": "ci-apps",
    "name": "Prometheus",
    "expectedPort": 9090,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "rocketchat",
    "storeSlug": "ci-apps",
    "name": "Rocket.Chat",
    "expectedPort": 3000,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low"
  },
  {
    "id": "seafile",
    "storeSlug": "ci-apps",
    "name": "Seafile",
    "expectedPort": 8920,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low"
  },
  {
    "id": "searxng",
    "storeSlug": "ci-apps",
    "name": "SearXNG",
    "expectedPort": 8325,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "sillytavern",
    "storeSlug": "ci-apps",
    "name": "SillyTavern",
    "expectedPort": 8925,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low"
  },
  {
    "id": "smartest-tv-mcp",
    "storeSlug": "ci-apps",
    "name": "Smartest TV MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "solidtime",
    "storeSlug": "ci-apps",
    "name": "Solidtime",
    "expectedPort": 8050,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "sqlite-mcp",
    "storeSlug": "ci-apps",
    "name": "SQLite MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "data"
    ],
    "priority": "low"
  },
  {
    "id": "stalwart-mail",
    "storeSlug": "ci-apps",
    "name": "Stalwart Mail",
    "expectedPort": 8677,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "standard-notes",
    "storeSlug": "ci-apps",
    "name": "Standard Notes",
    "expectedPort": 9032,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low"
  },
  {
    "id": "steam-mcp",
    "storeSlug": "ci-apps",
    "name": "Steam MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "data",
      "utilities"
    ],
    "priority": "low"
  }
];

test.describe('App Catalog Batch 8', () => {
  test.beforeEach(async ({ page, context }) => {
    await loginUser(page, context);
  });

  for (const app of APPS) {
    test.describe(`App: ${app.name}`, () => {
      test(`install ${app.id}`, async ({ page }) => {
        await page.goto(`/app-store/${app.storeSlug}/${app.id}`);
        await page.getByRole('button', { name: 'Install' }).click();
        await expect(page.getByText(/running|installed/i)).toBeVisible({ 
          timeout: 180000 
        });
      });

      if (app.hasGui) {
        test(`access ${app.id} via subdomain`, async ({ page, context }) => {
          const subdomain = `test-${app.id}`;
          const url = `https://${subdomain}.${process.env.TEST_DOMAIN || 'test.ci.computer'}${app.healthEndpoint}`;
          
          const appPage = await context.newPage();
          const response = await appPage.goto(url, { 
            waitUntil: 'domcontentloaded',
            timeout: 60000 
          });
          
          expect(response?.status()).toBeLessThan(500);
          
          await appPage.screenshot({
            path: `./e2e/screenshots/catalog/${app.id}.png`,
            fullPage: true,
          });
          
          await appPage.close();
        });
      }

      test(`cleanup ${app.id}`, async ({ page }) => {
        await page.goto(`/apps/${app.id}`);
        await page.getByRole('button', { name: /delete|uninstall/i }).click();
        await page.getByRole('button', { name: /confirm/i }).click();
        await expect(page.getByText(/deleted|removed/i)).toBeVisible({ 
          timeout: 60000 
        });
      });
    });
  }
});
