
/**
 * Auto-generated app catalog tests for server batch 6
 * Generated: 2026-05-31T17:54:12.916Z
 * Apps: 13
 */

import { expect, installApp, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    "id": "logseq",
    "storeSlug": "ci-apps",
    "name": "Logseq",
    "expectedPort": 8323,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "data"
    ],
    "priority": "low"
  },
  {
    "id": "macos",
    "storeSlug": "ci-apps",
    "name": "macOS",
    "expectedPort": 8006,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "matomo",
    "storeSlug": "ci-apps",
    "name": "Matomo",
    "expectedPort": 8420,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "mattermost",
    "storeSlug": "ci-apps",
    "name": "Mattermost",
    "expectedPort": 8265,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low"
  },
  {
    "id": "memory-mcp",
    "storeSlug": "ci-apps",
    "name": "Memory MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "ai",
      "data"
    ],
    "priority": "low"
  },
  {
    "id": "miro-mcp",
    "storeSlug": "ci-apps",
    "name": "Miro MCP",
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
    "id": "mixpost",
    "storeSlug": "ci-apps",
    "name": "Mixpost",
    "expectedPort": 9000,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social",
      "automation"
    ],
    "priority": "low"
  },
  {
    "id": "n8n",
    "storeSlug": "ci-apps",
    "name": "n8n",
    "expectedPort": 8579,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "automation",
      "featured"
    ],
    "priority": "low"
  },
  {
    "id": "netdata",
    "storeSlug": "ci-apps",
    "name": "Netdata",
    "expectedPort": 19999,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "nocodb",
    "storeSlug": "ci-apps",
    "name": "NocoDB",
    "expectedPort": 9020,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low"
  },
  {
    "id": "notion-mcp",
    "storeSlug": "ci-apps",
    "name": "Notion MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "utilities",
      "data"
    ],
    "priority": "low"
  },
  {
    "id": "novel",
    "storeSlug": "ci-apps",
    "name": "Novel",
    "expectedPort": 3579,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "ai"
    ],
    "priority": "low"
  },
  {
    "id": "obsidian-mcp",
    "storeSlug": "ci-apps",
    "name": "Obsidian MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "utilities",
      "data"
    ],
    "priority": "low"
  }
];

test.describe('App Catalog Batch 6', () => {
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
