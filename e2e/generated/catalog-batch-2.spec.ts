/**
 * Auto-generated app catalog tests for server batch 2
 * Generated: 2026-05-31T18:47:03.861Z
 * Apps: 13
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
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
    categories: ['media', 'featured'],
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
    id: 'unity-mcp-ivanmurzak',
    storeSlug: 'ci-apps',
    name: 'Unity MCP (Ivan Murzak)',
    expectedPort: 80,
    healthEndpoint: '/',
    hasGui: false,
    categories: ['mcp', 'utilities', 'development'],
    priority: 'medium',
  },
  {
    id: 'unreal-engine-mcp',
    storeSlug: 'ci-apps',
    name: 'Unreal Engine MCP',
    expectedPort: 80,
    healthEndpoint: '/',
    hasGui: false,
    categories: ['mcp', 'utilities', 'development'],
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
