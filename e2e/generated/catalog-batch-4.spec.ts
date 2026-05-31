/**
 * Auto-generated app catalog tests for server batch 4
 * Generated: 2026-05-31T18:47:03.862Z
 * Apps: 13
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
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
    id: 'doordash-mcp',
    storeSlug: 'ci-apps',
    name: 'DoorDash MCP Server',
    expectedPort: 80,
    healthEndpoint: '/',
    hasGui: false,
    categories: ['mcp', 'network', 'utilities'],
    priority: 'low',
  },
  {
    id: 'dropgate',
    storeSlug: 'ci-apps',
    name: 'Dropgate',
    expectedPort: 8395,
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
    categories: ['data', 'featured'],
    priority: 'low',
  },
  {
    id: 'excalidraw-mcp',
    storeSlug: 'ci-apps',
    name: 'Excalidraw MCP',
    expectedPort: 80,
    healthEndpoint: '/',
    hasGui: false,
    categories: ['mcp', 'utilities'],
    priority: 'low',
  },
  {
    id: 'fetch-mcp',
    storeSlug: 'ci-apps',
    name: 'Fetch MCP',
    expectedPort: 80,
    healthEndpoint: '/',
    hasGui: false,
    categories: ['mcp', 'network'],
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
    id: 'filesystem-mcp',
    storeSlug: 'ci-apps',
    name: 'Filesystem MCP',
    expectedPort: 80,
    healthEndpoint: '/',
    hasGui: false,
    categories: ['mcp', 'utilities'],
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
