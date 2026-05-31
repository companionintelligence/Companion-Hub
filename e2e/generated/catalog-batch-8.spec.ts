/**
 * Auto-generated app catalog tests for server batch 8
 * Generated: 2026-05-31T15:37:35.478Z
 * Apps: 10
 */

import { expect, installApp, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    id: 'passbolt',
    storeSlug: 'ci-apps',
    name: 'Passbolt',
    expectedPort: 8085,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['security'],
    priority: 'low',
  },
  {
    id: 'photoprism',
    storeSlug: 'ci-apps',
    name: 'PhotoPrism',
    expectedPort: 8087,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data'],
    priority: 'low',
  },
  {
    id: 'pi-hole',
    storeSlug: 'ci-apps',
    name: 'Pi-hole',
    expectedPort: 8082,
    healthEndpoint: '/admin',
    hasGui: true,
    categories: ['network'],
    priority: 'low',
  },
  {
    id: 'plane',
    storeSlug: 'ci-apps',
    name: 'Plane',
    expectedPort: 8080,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities'],
    priority: 'low',
  },
  {
    id: 'postiz',
    storeSlug: 'ci-apps',
    name: 'Postiz',
    expectedPort: 8921,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['social'],
    priority: 'low',
  },
  {
    id: 'prestashop',
    storeSlug: 'ci-apps',
    name: 'PrestaShop',
    expectedPort: 8923,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['finance'],
    priority: 'low',
  },
  {
    id: 'prometheus',
    storeSlug: 'ci-apps',
    name: 'Prometheus',
    expectedPort: 9090,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities'],
    priority: 'low',
  },
  {
    id: 'rocketchat',
    storeSlug: 'ci-apps',
    name: 'Rocket.Chat',
    expectedPort: 3000,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['social'],
    priority: 'low',
  },
  {
    id: 'seafile',
    storeSlug: 'ci-apps',
    name: 'Seafile',
    expectedPort: 8920,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data'],
    priority: 'low',
  },
  {
    id: 'searxng',
    storeSlug: 'ci-apps',
    name: 'SearXNG',
    expectedPort: 8325,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities'],
    priority: 'low',
  },
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
