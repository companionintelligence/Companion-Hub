/**
 * Auto-generated app catalog tests for server batch 4
 * Generated: 2026-06-05T21:00:37.814Z
 * Apps: 17
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    id: 'comfyui',
    storeSlug: 'ci-apps',
    name: 'ComfyUI',
    expectedPort: 8188,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['ai', 'featured'],
    priority: 'low',
  },
  {
    id: 'cypht',
    storeSlug: 'ci-apps',
    name: 'Cypht',
    expectedPort: 8077,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['social'],
    priority: 'low',
  },
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
    id: 'freeter',
    storeSlug: 'ci-apps',
    name: 'Freeter',
    expectedPort: 8989,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['utilities'],
    priority: 'low',
  },
];

test.describe('App Catalog Batch 4', () => {
  for (const app of APPS) {
    // One test per app so install -> access -> cleanup share a single Hub/DB state.
    // The custom `page` fixture resets the backend DB the first time it is used, so
    // splitting these into separate tests wiped the install record (and left the Docker
    // deployment behind) before access/cleanup ran.
    test(`App: ${app.name}`, async ({ page, context }) => {
      await loginUser(page, context);

      // Install
      await page.goto(`/app-store/${app.storeSlug}/${app.id}`);
      await page.getByRole('button', { name: 'Install' }).click();
      await expect(page.getByText(/running|installed/i)).toBeVisible({ timeout: 180000 });

      // Access via subdomain (GUI apps only) + screenshot for evidence
      if (app.hasGui) {
        const subdomain = `test-${app.id}`;
        const url = `https://${subdomain}.${process.env.TEST_DOMAIN || 'test.ci.computer'}${app.healthEndpoint}`;
        const appPage = await context.newPage();
        const response = await appPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        expect(response?.status()).toBeLessThan(500);
        await appPage.screenshot({ path: `./e2e/screenshots/catalog/${app.id}.png`, fullPage: true });
        await appPage.close();
      }

      // Cleanup (uninstall) — the same state that performed the install
      await page.goto(`/apps/${app.id}`);
      await page.getByRole('button', { name: /delete|uninstall/i }).click();
      await page.getByRole('button', { name: /confirm/i }).click();
      await expect(page.getByText(/deleted|removed/i)).toBeVisible({ timeout: 60000 });
    });
  }
});
