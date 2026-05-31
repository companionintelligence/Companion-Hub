/**
 * Auto-generated app catalog tests for server batch 2
 * Generated: 2026-05-31T16:04:12.523Z
 * Apps: 10
 */

import { expect, installApp, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    id: 'penpot',
    storeSlug: 'ci-apps',
    name: 'Penpot',
    expectedPort: 9001,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['development'],
    priority: 'medium',
  },
  {
    id: 'plausible',
    storeSlug: 'ci-apps',
    name: 'Plausible Analytics',
    expectedPort: 9092,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['development'],
    priority: 'medium',
  },
  {
    id: 'pocketbase',
    storeSlug: 'ci-apps',
    name: 'PocketBase',
    expectedPort: 5400,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['development'],
    priority: 'medium',
  },
  {
    id: 'steam-headless',
    storeSlug: 'ci-apps',
    name: 'Steam Headless',
    expectedPort: 8184,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['media'],
    priority: 'medium',
  },
  {
    id: 'taiga',
    storeSlug: 'ci-apps',
    name: 'Taiga',
    expectedPort: 8290,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['development'],
    priority: 'medium',
  },
  {
    id: 'tldraw',
    storeSlug: 'ci-apps',
    name: 'tldraw',
    expectedPort: 8322,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities', 'development'],
    priority: 'medium',
  },
  {
    id: 'umami',
    storeSlug: 'ci-apps',
    name: 'Umami',
    expectedPort: 25727,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['development'],
    priority: 'medium',
  },
  {
    id: 'woodpecker-ci',
    storeSlug: 'ci-apps',
    name: 'Woodpecker CI',
    expectedPort: 8000,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['development'],
    priority: 'medium',
  },
  {
    id: 'activepieces',
    storeSlug: 'ci-apps',
    name: 'Activepieces',
    expectedPort: 8146,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['automation'],
    priority: 'low',
  },
  {
    id: 'adguardhome-sync',
    storeSlug: 'ci-apps',
    name: 'Adguard Home Sync',
    expectedPort: 8436,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['network', 'utilities'],
    priority: 'low',
  },
];

test.describe('App Catalog Batch 2', () => {
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
