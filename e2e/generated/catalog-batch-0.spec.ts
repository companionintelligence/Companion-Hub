/**
 * Auto-generated app catalog tests for server batch 0
 * Generated: 2026-05-31T15:37:35.475Z
 * Apps: 10
 */

import { expect, installApp, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    id: 'code-server',
    storeSlug: 'ci-apps',
    name: 'Code Server',
    expectedPort: 8138,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['development'],
    priority: 'high',
  },
  {
    id: 'home-assistant',
    storeSlug: 'ci-apps',
    name: 'Home Assistant',
    expectedPort: 7659,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['automation'],
    priority: 'high',
  },
  {
    id: 'immich',
    storeSlug: 'ci-apps',
    name: 'Immich',
    expectedPort: 9008,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data', 'media', 'photography'],
    priority: 'high',
  },
  {
    id: 'jellyfin',
    storeSlug: 'ci-apps',
    name: 'Jellyfin',
    expectedPort: 8096,
    healthEndpoint: '/web/index.html',
    hasGui: true,
    categories: ['media'],
    priority: 'high',
  },
  {
    id: 'nextcloud',
    storeSlug: 'ci-apps',
    name: 'Nextcloud',
    expectedPort: 8301,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data'],
    priority: 'high',
  },
  {
    id: 'open-webui',
    storeSlug: 'ci-apps',
    name: 'Open WebUI',
    expectedPort: 2876,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['ai'],
    priority: 'high',
  },
  {
    id: 'plex',
    storeSlug: 'ci-apps',
    name: 'Plex',
    expectedPort: 32400,
    healthEndpoint: '/web/index.html',
    hasGui: true,
    categories: ['media'],
    priority: 'high',
  },
  {
    id: 'uptime-kuma',
    storeSlug: 'ci-apps',
    name: 'Uptime Kuma',
    expectedPort: 8125,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities', 'network'],
    priority: 'high',
  },
  {
    id: 'vaultwarden',
    storeSlug: 'ci-apps',
    name: 'VaultWarden',
    expectedPort: 9010,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data', 'security'],
    priority: 'high',
  },
  {
    id: 'appwrite',
    storeSlug: 'ci-apps',
    name: 'Appwrite',
    expectedPort: 8924,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['development'],
    priority: 'medium',
  },
];

test.describe('App Catalog Batch 0', () => {
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
