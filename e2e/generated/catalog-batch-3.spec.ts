
/**
 * Auto-generated app catalog tests for server batch 3
 * Generated: 2026-06-05T14:56:11.320Z
 * Apps: 17
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    "id": "archivebox",
    "storeSlug": "ci-apps",
    "name": "ArchiveBox",
    "expectedPort": 8428,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "baserow",
    "storeSlug": "ci-apps",
    "name": "Baserow",
    "expectedPort": 8317,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "bitcoind",
    "storeSlug": "ci-apps",
    "name": "Bitcoin",
    "expectedPort": 8333,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low"
  },
  {
    "id": "blender-mcp",
    "storeSlug": "ci-apps",
    "name": "Blender MCP",
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
    "id": "brewers-almanack-mcp",
    "storeSlug": "ci-apps",
    "name": "Brewers Almanack MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "data",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "bytebase",
    "storeSlug": "ci-apps",
    "name": "Bytebase",
    "expectedPort": 8326,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "chess-mcp",
    "storeSlug": "ci-apps",
    "name": "MCP Chess",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "ai",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "ci-hermes",
    "storeSlug": "ci-apps",
    "name": "Hermes",
    "expectedPort": 18790,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "ai",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "ci-import-tools",
    "storeSlug": "ci-apps",
    "name": "Import Tools",
    "expectedPort": 18802,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "ci-just-in-case",
    "storeSlug": "ci-apps",
    "name": "Just In Case",
    "expectedPort": 18806,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "ci-local-bench",
    "storeSlug": "ci-apps",
    "name": "Local Bench",
    "expectedPort": 18807,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "ci-openclaw",
    "storeSlug": "ci-apps",
    "name": "OpenClaw WebCLI",
    "expectedPort": 18789,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "ai",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "ci-spellbook",
    "storeSlug": "ci-apps",
    "name": "Spellbook",
    "expectedPort": 18805,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "ci-tools-cache-mounts",
    "storeSlug": "ci-apps",
    "name": "Tools Cache Mount",
    "expectedPort": 18808,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "cloudreve",
    "storeSlug": "ci-apps",
    "name": "Cloudreve",
    "expectedPort": 5212,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "colanode",
    "storeSlug": "ci-apps",
    "name": "Colanode",
    "expectedPort": 4011,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social",
      "data"
    ],
    "priority": "low"
  },
  {
    "id": "collabora-online",
    "storeSlug": "ci-apps",
    "name": "Collabora Online",
    "expectedPort": 9980,
    "healthEndpoint": "/browser/dist/admin/admin.html",
    "hasGui": true,
    "categories": [
      "featured",
      "utilities"
    ],
    "priority": "low"
  }
];

test.describe('App Catalog Batch 3', () => {
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
