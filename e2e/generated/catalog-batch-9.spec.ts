/**
 * Auto-generated app catalog tests for server batch 9
 * Generated: 2026-05-31T18:47:03.868Z
 * Apps: 9
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    id: 'steam-mcp',
    storeSlug: 'ci-apps',
    name: 'Steam MCP',
    expectedPort: 80,
    healthEndpoint: '/',
    hasGui: false,
    categories: ['mcp', 'data', 'utilities'],
    priority: 'low',
  },
  {
    id: 'stirling-pdf',
    storeSlug: 'ci-apps',
    name: 'Stirling-PDF',
    expectedPort: 8234,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities', 'data'],
    priority: 'low',
  },
  {
    id: 'teable',
    storeSlug: 'ci-apps',
    name: 'Teable',
    expectedPort: 8925,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data'],
    priority: 'low',
  },
  {
    id: 'twenty',
    storeSlug: 'ci-apps',
    name: 'Twenty',
    expectedPort: 2020,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data'],
    priority: 'low',
  },
  {
    id: 'unity-mcp',
    storeSlug: 'ci-apps',
    name: 'Unity MCP',
    expectedPort: 80,
    healthEndpoint: '/',
    hasGui: false,
    categories: ['mcp', 'utilities'],
    priority: 'low',
  },
  {
    id: 'vane',
    storeSlug: 'ci-apps',
    name: 'Vane',
    expectedPort: 7458,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['ai'],
    priority: 'low',
  },
  {
    id: 'wallos',
    storeSlug: 'ci-apps',
    name: 'Wallos',
    expectedPort: 8222,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['finance', 'utilities'],
    priority: 'low',
  },
  {
    id: 'windows',
    storeSlug: 'ci-apps',
    name: 'Windows',
    expectedPort: 8006,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities'],
    priority: 'low',
  },
  {
    id: 'wordpress',
    storeSlug: 'ci-apps',
    name: 'WordPress',
    expectedPort: 8213,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['social'],
    priority: 'low',
  },
];

test.describe('App Catalog Batch 9', () => {
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
