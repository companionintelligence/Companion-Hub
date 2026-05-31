/**
 * Auto-generated app catalog tests for server batch 7
 * Generated: 2026-05-31T18:47:03.866Z
 * Apps: 13
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    id: 'obsidian-mcp',
    storeSlug: 'ci-apps',
    name: 'Obsidian MCP',
    expectedPort: 80,
    healthEndpoint: '/',
    hasGui: false,
    categories: ['mcp', 'utilities', 'data'],
    priority: 'low',
  },
  {
    id: 'odoo',
    storeSlug: 'ci-apps',
    name: 'Odoo',
    expectedPort: 8069,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities'],
    priority: 'low',
  },
  {
    id: 'onlyoffice',
    storeSlug: 'ci-apps',
    name: 'ONLYOFFICE Docs',
    expectedPort: 6829,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities'],
    priority: 'low',
  },
  {
    id: 'onlyoffice-docspace-mcp',
    storeSlug: 'ci-apps',
    name: 'ONLYOFFICE DocSpace MCP',
    expectedPort: 80,
    healthEndpoint: '/',
    hasGui: false,
    categories: ['mcp', 'utilities', 'data'],
    priority: 'low',
  },
  {
    id: 'openclaw',
    storeSlug: 'ci-apps',
    name: 'OpenClaw',
    expectedPort: 30189,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['ai', 'utilities', 'featured'],
    priority: 'low',
  },
  {
    id: 'openproject',
    storeSlug: 'ci-apps',
    name: 'OpenProject',
    expectedPort: 8080,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['data', 'utilities'],
    priority: 'low',
  },
  {
    id: 'paddle-ocr',
    storeSlug: 'ci-apps',
    name: 'PaddleOCR',
    expectedPort: 8888,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['ai'],
    priority: 'low',
  },
  {
    id: 'pairdrop',
    storeSlug: 'ci-apps',
    name: 'PairDrop',
    expectedPort: 8321,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities', 'network'],
    priority: 'low',
  },
  {
    id: 'papercups',
    storeSlug: 'ci-apps',
    name: 'Papercups',
    expectedPort: 4000,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['social'],
    priority: 'low',
  },
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
    categories: ['network', 'featured'],
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
];

test.describe('App Catalog Batch 7', () => {
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
