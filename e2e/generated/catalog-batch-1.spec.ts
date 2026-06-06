/**
 * Auto-generated app catalog tests for server batch 1
 * Generated: 2026-06-06T04:28:32.810Z
 * Apps: 17
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    id: 'emulatorjs',
    storeSlug: 'ci-apps',
    name: 'EmulatorJS',
    expectedPort: 8164,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['media'],
    priority: 'medium',
  },
  {
    id: 'forgejo',
    storeSlug: 'ci-apps',
    name: 'Forgejo',
    expectedPort: 8101,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['development'],
    priority: 'medium',
  },
  {
    id: 'git-mcp',
    storeSlug: 'ci-apps',
    name: 'Git MCP',
    expectedPort: 80,
    healthEndpoint: '/',
    hasGui: false,
    categories: ['mcp', 'development'],
    priority: 'medium',
  },
  {
    id: 'gitea',
    storeSlug: 'ci-apps',
    name: 'Gitea',
    expectedPort: 8283,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['development', 'featured'],
    priority: 'medium',
  },
  {
    id: 'github-mcp',
    storeSlug: 'ci-apps',
    name: 'GitHub MCP',
    expectedPort: 80,
    healthEndpoint: '/',
    hasGui: false,
    categories: ['mcp', 'development'],
    priority: 'medium',
  },
  {
    id: 'gitlab',
    storeSlug: 'ci-apps',
    name: 'GitLab CE',
    expectedPort: 8929,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['development'],
    priority: 'medium',
  },
  {
    id: 'hunyuan3d',
    storeSlug: 'ci-apps',
    name: 'Hunyuan3D',
    expectedPort: 18821,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['media'],
    priority: 'medium',
  },
  {
    id: 'hunyuan3d-rocm',
    storeSlug: 'ci-apps',
    name: 'Hunyuan3D ROCm',
    expectedPort: 18815,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['media'],
    priority: 'medium',
  },
  {
    id: 'inkscape',
    storeSlug: 'ci-apps',
    name: 'Inkscape',
    expectedPort: 18824,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['media'],
    priority: 'medium',
  },
  {
    id: 'medusa',
    storeSlug: 'ci-apps',
    name: 'Medusa',
    expectedPort: 18900,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['development'],
    priority: 'medium',
  },
  {
    id: 'music-assistant',
    storeSlug: 'ci-apps',
    name: 'Music Assistant',
    expectedPort: 8095,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['media'],
    priority: 'medium',
  },
  {
    id: 'n8n-mcp',
    storeSlug: 'ci-apps',
    name: 'n8n MCP',
    expectedPort: 80,
    healthEndpoint: '/',
    hasGui: false,
    categories: ['mcp', 'development', 'utilities'],
    priority: 'medium',
  },
  {
    id: 'opencode-web',
    storeSlug: 'ci-apps',
    name: 'OpenCode Web',
    expectedPort: 4019,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['ai', 'development'],
    priority: 'medium',
  },
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
    id: 'playwright-mcp',
    storeSlug: 'ci-apps',
    name: 'Playwright MCP',
    expectedPort: 80,
    healthEndpoint: '/',
    hasGui: false,
    categories: ['mcp', 'network', 'development'],
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
];

test.describe('App Catalog Batch 1', () => {
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
