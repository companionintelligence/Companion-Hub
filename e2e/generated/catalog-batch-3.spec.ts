/**
 * Auto-generated app catalog tests for server batch 3
 * Generated: 2026-05-31T15:37:35.477Z
 * Apps: 10
 */

import { expect, installApp, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    id: 'affine',
    storeSlug: 'ci-apps',
    name: 'Affine',
    expectedPort: 3013,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data'],
    priority: 'low',
  },
  {
    id: 'anything-llm',
    storeSlug: 'ci-apps',
    name: 'AnythingLLM',
    expectedPort: 3001,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['ai', 'utilities'],
    priority: 'low',
  },
  {
    id: 'appflowy',
    storeSlug: 'ci-apps',
    name: 'AppFlowy',
    expectedPort: 9036,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data'],
    priority: 'low',
  },
  {
    id: 'archivebox',
    storeSlug: 'ci-apps',
    name: 'ArchiveBox',
    expectedPort: 8428,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data', 'utilities'],
    priority: 'low',
  },
  {
    id: 'baserow',
    storeSlug: 'ci-apps',
    name: 'Baserow',
    expectedPort: 8317,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data', 'utilities'],
    priority: 'low',
  },
  {
    id: 'bitcoind',
    storeSlug: 'ci-apps',
    name: 'Bitcoin',
    expectedPort: 8333,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['finance'],
    priority: 'low',
  },
  {
    id: 'ci-hermes',
    storeSlug: 'ci-apps',
    name: 'Hermes',
    expectedPort: 18790,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['ai', 'utilities'],
    priority: 'low',
  },
  {
    id: 'ci-openclaw',
    storeSlug: 'ci-apps',
    name: 'OpenClaw WebCLI',
    expectedPort: 18789,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['ai', 'utilities'],
    priority: 'low',
  },
  {
    id: 'collabora-online',
    storeSlug: 'ci-apps',
    name: 'Collabora Online',
    expectedPort: 9980,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities'],
    priority: 'low',
  },
  {
    id: 'comfyui',
    storeSlug: 'ci-apps',
    name: 'ComfyUI',
    expectedPort: 8188,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['ai'],
    priority: 'low',
  },
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
