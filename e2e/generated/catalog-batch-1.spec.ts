/**
 * Auto-generated app catalog tests for server batch 1
 * Generated: 2026-05-31T18:47:03.860Z
 * Apps: 13
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
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
    expectedPort: 8080,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['media'],
    priority: 'medium',
  },
  {
    id: 'hunyuan3d-rocm',
    storeSlug: 'ci-apps',
    name: 'Hunyuan3D ROCm',
    expectedPort: 8188,
    healthEndpoint: '/',
    hasGui: true,
    categories: ['media'],
    priority: 'medium',
  },
  {
    id: 'inkscape',
    storeSlug: 'ci-apps',
    name: 'Inkscape',
    expectedPort: 8920,
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
];

test.describe('App Catalog Batch 1', () => {
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
        test(`access ${app.id} via subdomain`, async ({ context }) => {
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
