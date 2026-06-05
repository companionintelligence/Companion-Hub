
/**
 * Auto-generated app catalog tests for server batch 5
 * Generated: 2026-06-05T14:56:11.320Z
 * Apps: 17
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    "id": "frigate",
    "storeSlug": "ci-apps",
    "name": "Frigate",
    "expectedPort": 5004,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "automation"
    ],
    "priority": "low"
  },
  {
    "id": "galette",
    "storeSlug": "ci-apps",
    "name": "Galette",
    "expectedPort": 8081,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low"
  },
  {
    "id": "ghost",
    "storeSlug": "ci-apps",
    "name": "Ghost",
    "expectedPort": 3368,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data",
      "featured"
    ],
    "priority": "low"
  },
  {
    "id": "graylog",
    "storeSlug": "ci-apps",
    "name": "Graylog",
    "expectedPort": 9000,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security",
      "data"
    ],
    "priority": "low"
  },
  {
    "id": "grocy",
    "storeSlug": "ci-apps",
    "name": "Grocy",
    "expectedPort": 9283,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "hermes-agent",
    "storeSlug": "ci-apps",
    "name": "Hermes Agent",
    "expectedPort": 9119,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "utilities",
      "featured"
    ],
    "priority": "low"
  },
  {
    "id": "hoppscotch",
    "storeSlug": "ci-apps",
    "name": "Hoppscotch",
    "expectedPort": 18820,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "jitsi",
    "storeSlug": "ci-apps",
    "name": "Jitsi Meet",
    "expectedPort": 8443,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "joplin",
    "storeSlug": "ci-apps",
    "name": "Joplin Server",
    "expectedPort": 9015,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low"
  },
  {
    "id": "keila",
    "storeSlug": "ci-apps",
    "name": "Keila",
    "expectedPort": 18825,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "network"
    ],
    "priority": "low"
  },
  {
    "id": "kiwix",
    "storeSlug": "ci-apps",
    "name": "Kiwix",
    "expectedPort": 8169,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "books",
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "langflow",
    "storeSlug": "ci-apps",
    "name": "Langflow",
    "expectedPort": 7860,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low"
  },
  {
    "id": "leantime",
    "storeSlug": "ci-apps",
    "name": "Leantime",
    "expectedPort": 8247,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low"
  },
  {
    "id": "lego-oracle-mcp",
    "storeSlug": "ci-apps",
    "name": "LEGO Oracle MCP",
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
    "id": "librechat",
    "storeSlug": "ci-apps",
    "name": "LibreChat",
    "expectedPort": 3080,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low"
  },
  {
    "id": "libreoffice",
    "storeSlug": "ci-apps",
    "name": "LibreOffice",
    "expectedPort": 5001,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low"
  },
  {
    "id": "librespeed",
    "storeSlug": "ci-apps",
    "name": "LibreSpeed",
    "expectedPort": 8383,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network",
      "utilities"
    ],
    "priority": "low"
  }
];

test.describe('App Catalog Batch 5', () => {
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
