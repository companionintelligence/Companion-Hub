/**
 * Auto-generated app catalog tests for server batch 4
 * Generated: 2026-05-31T16:04:12.524Z
 * Apps: 10
 */

import { expect, installApp, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    id: 'deepseek-ocr-webui',
    storeSlug: 'ci-apps',
    name: 'DeepSeek-OCR-WebUI',
    expectedPort: 8001,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['ai'],
    priority: 'low',
  },
  {
    id: 'docmost',
    storeSlug: 'ci-apps',
    name: 'Docmost',
    expectedPort: 3040,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data', 'utilities'],
    priority: 'low',
  },
  {
    id: 'documenso',
    storeSlug: 'ci-apps',
    name: 'Documenso',
    expectedPort: 8319,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities'],
    priority: 'low',
  },
  {
    id: 'docuseal',
    storeSlug: 'ci-apps',
    name: 'Docuseal',
    expectedPort: 5341,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities'],
    priority: 'low',
  },
  {
    id: 'element',
    storeSlug: 'ci-apps',
    name: 'Element',
    expectedPort: 8088,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['social'],
    priority: 'low',
  },
  {
    id: 'espocrm',
    storeSlug: 'ci-apps',
    name: 'EspoCRM',
    expectedPort: 8922,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data'],
    priority: 'low',
  },
  {
    id: 'excalidraw',
    storeSlug: 'ci-apps',
    name: 'Excalidraw',
    expectedPort: 4422,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data'],
    priority: 'low',
  },
  {
    id: 'file-browser',
    storeSlug: 'ci-apps',
    name: 'File Browser',
    expectedPort: 7421,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data'],
    priority: 'low',
  },
  {
    id: 'flowise',
    storeSlug: 'ci-apps',
    name: 'Flowise',
    expectedPort: 3002,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['ai'],
    priority: 'low',
  },
  {
    id: 'frigate',
    storeSlug: 'ci-apps',
    name: 'Frigate',
    expectedPort: 5004,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['automation'],
    priority: 'low',
  },
];

test.describe('App Catalog Batch 4', () => {
  test.beforeEach(async ({ page, context }) => {
    await loginUser(page, context);
  });

  for (const app of APPS) {
    test.describe(`App: ${app.name}`, () => {
      test(`install ${app.id}`, async ({ page }) => {
        await page.goto(`/app-store/${app.storeSlug}/${app.id}`);
        await page.getByRole('button', { name: 'Install' }).click();
        await expect(page.getByText(/running|installed/i)).toBeVisible({
          timeout: 180000,
        });
      });

      if (app.hasGui) {
        test(`access ${app.id} via subdomain`, async ({ page, context }) => {
          const subdomain = `test-${app.id}`;
          const url = `https://${subdomain}.${process.env.TEST_DOMAIN || 'test.ci.computer'}${app.healthEndpoint}`;

          const appPage = await context.newPage();
          const response = await appPage.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
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
          timeout: 60000,
        });
      });
    });
  }
});
