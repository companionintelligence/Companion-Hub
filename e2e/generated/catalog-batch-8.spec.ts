
/**
 * Auto-generated app catalog tests for server batch 8
 * Generated: 2026-06-05T14:56:11.320Z
 * Apps: 17
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    "id": "postgres-mcp",
    "storeSlug": "ci-apps",
    "name": "Postgres MCP",
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
    "id": "postiz",
    "storeSlug": "ci-apps",
    "name": "Postiz",
    "expectedPort": 4007,
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
    "id": "qbittorrent",
    "storeSlug": "ci-apps",
    "name": "qBittorrent",
    "expectedPort": 8327,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "readeck",
    "storeSlug": "ci-apps",
    "name": "Readeck",
    "expectedPort": 8592,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "books"
    ],
    "priority": "low"
  },
  {
    "id": "rms-mail",
    "storeSlug": "ci-apps",
    "name": "RMS Mail",
    "expectedPort": 8330,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
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
    "id": "rolltop",
    "storeSlug": "ci-apps",
    "name": "Rolltop",
    "expectedPort": 8329,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "data"
    ],
    "priority": "low"
  },
  {
    "id": "safeos",
    "storeSlug": "ci-apps",
    "name": "SafeOS Guardian",
    "expectedPort": 18900,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "security",
      "ai"
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
    "id": "securo",
    "storeSlug": "ci-apps",
    "name": "Securo",
    "expectedPort": 8331,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low"
  },
  {
    "id": "sillytavern",
    "storeSlug": "ci-apps",
    "name": "SillyTavern",
    "expectedPort": 18828,
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
    "id": "snort",
    "storeSlug": "ci-apps",
    "name": "Snort",
    "expectedPort": 52027,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
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
        test(`access ${app.id} via subdomain`, async ({ context }) => {
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
