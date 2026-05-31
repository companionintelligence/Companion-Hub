/**
 * Auto-generated app catalog tests for server batch 5
 * Generated: 2026-05-31T15:37:35.477Z
 * Apps: 10
 */

import { expect, installApp, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    id: 'galette',
    storeSlug: 'ci-apps',
    name: 'Galette',
    expectedPort: 8081,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['finance'],
    priority: 'low',
  },
  {
    id: 'ghost',
    storeSlug: 'ci-apps',
    name: 'Ghost',
    expectedPort: 3368,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data'],
    priority: 'low',
  },
  {
    id: 'graylog',
    storeSlug: 'ci-apps',
    name: 'Graylog',
    expectedPort: 9000,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['security', 'data'],
    priority: 'low',
  },
  {
    id: 'hermes-agent',
    storeSlug: 'ci-apps',
    name: 'Hermes Agent',
    expectedPort: 9119,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['ai', 'utilities'],
    priority: 'low',
  },
  {
    id: 'hoppscotch',
    storeSlug: 'ci-apps',
    name: 'Hoppscotch',
    expectedPort: 3000,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities'],
    priority: 'low',
  },
  {
    id: 'jitsi',
    storeSlug: 'ci-apps',
    name: 'Jitsi Meet',
    expectedPort: 8443,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities'],
    priority: 'low',
  },
  {
    id: 'joplin',
    storeSlug: 'ci-apps',
    name: 'Joplin Server',
    expectedPort: 9015,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data'],
    priority: 'low',
  },
  {
    id: 'keila',
    storeSlug: 'ci-apps',
    name: 'Keila',
    expectedPort: 4000,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities', 'network'],
    priority: 'low',
  },
  {
    id: 'kiwix',
    storeSlug: 'ci-apps',
    name: 'Kiwix',
    expectedPort: 8169,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['books', 'utilities'],
    priority: 'low',
  },
  {
    id: 'leantime',
    storeSlug: 'ci-apps',
    name: 'Leantime',
    expectedPort: 8247,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities'],
    priority: 'low',
  },
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
