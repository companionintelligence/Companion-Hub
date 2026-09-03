/**
 * App lifecycle test generator for Docker-in-Docker catalog testing.
 *
 * This is preserved from the original e2e/future/app-store-lifecycle.spec.ts
 * for use in full Docker-in-Docker E2E runs. It is NOT part of the standard
 * CI gate — it requires a real Docker daemon and app catalog.
 *
 * Usage: provide a generated/catalog.json file and run via:
 *   docker compose -f e2e/docker-compose.e2e.yml up
 */

import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const BASE_URL = process.env.HUB_URL || 'http://localhost:5005';
const TEST_DOMAIN = process.env.TEST_DOMAIN || 'test.ci.computer';
const SCREENSHOTS_DIR = 'e2e/screenshots';

const TEST_USER = {
  email: process.env.E2E_TEST_EMAIL || 'test@ci.computer',
  password: process.env.E2E_TEST_PASSWORD || 'testpassword123',
};

export interface AppTestConfig {
  id: string;
  storeSlug: string;
  name: string;
  expectedPort: number;
  healthEndpoint: string;
  hasGui: boolean;
  categories: string[];
  priority: 'high' | 'medium' | 'low';
}

[SCREENSHOTS_DIR, `${SCREENSHOTS_DIR}/baselines`, `${SCREENSHOTS_DIR}/current`, `${SCREENSHOTS_DIR}/diffs`].forEach((dir) => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.getByPlaceholder(/email/i).fill(TEST_USER.email);
  await page.getByPlaceholder(/password/i).fill(TEST_USER.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.getByText(/dashboard|my apps/i)).toBeVisible({ timeout: 15000 });
}

async function installApp(page: Page, app: AppTestConfig, options: { subdomain?: string } = {}) {
  const startTime = Date.now();
  try {
    await page.goto(`${BASE_URL}/app-store/${app.storeSlug}/${app.id}`);
    await expect(page.getByRole('heading', { name: app.name })).toBeVisible({ timeout: 10000 });
    if (options.subdomain) {
      const input = page.getByTestId('subdomain-input');
      if (await input.isVisible()) await input.fill(options.subdomain);
    }
    await page.getByRole('button', { name: /install/i }).click();
    await expect(page.getByText(/installing|configuring|downloading/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/running|installed|ready/i)).toBeVisible({ timeout: 180000 });
    return { success: true, duration: Date.now() - startTime };
  } catch (error: unknown) {
    return { success: false, duration: Date.now() - startTime, error: error instanceof Error ? error.message : String(error) };
  }
}

async function verifyHealth(context: BrowserContext, app: AppTestConfig, subdomain: string) {
  const startTime = Date.now();
  const url = `https://${subdomain}.${TEST_DOMAIN}${app.healthEndpoint}`;
  try {
    const appPage = await context.newPage();
    const response = await appPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status = response?.status() || 0;
    await appPage.close();
    return { success: status >= 200 && status < 500, status, duration: Date.now() - startTime };
  } catch (error: unknown) {
    return { success: false, duration: Date.now() - startTime, error: error instanceof Error ? error.message : String(error) };
  }
}

function verifyContainerCleanup(app: AppTestConfig) {
  try {
    const output = execSync(`docker ps -a --format "{{.Names}}" | grep -i "${app.id}" || true`, { encoding: 'utf-8' }).trim();
    const containers = output.split('\n').filter(Boolean);
    return { success: containers.length === 0, containersFound: containers };
  } catch {
    return { success: true, containersFound: [] };
  }
}

export function generateAppLifecycleTest(app: AppTestConfig) {
  test.describe(`App Lifecycle: ${app.name}`, () => {
    const subdomain = `test-${app.id.slice(0, 20)}`;

    test.beforeAll(async () => {
      try {
        execSync(`docker stop ci-${app.id} 2>/dev/null; docker rm ci-${app.id} 2>/dev/null`, { stdio: 'pipe' });
      } catch {
        // Container may not exist
      }
    });

    test(`[${app.id}] should install from store`, async ({ page }) => {
      await login(page);
      const result = await installApp(page, app, { subdomain });
      expect(result.success).toBe(true);
      expect(result.duration).toBeLessThan(180000);
    });

    test(`[${app.id}] should be accessible via subdomain`, async ({ page, context }) => {
      if (!app.hasGui) {
        test.skip();
        return;
      }
      await login(page);
      await page.goto(`${BASE_URL}/apps/${app.id}`);
      await expect(page.getByText(/running/i)).toBeVisible({ timeout: 10000 });
      const result = await verifyHealth(context, app, subdomain);
      expect(result.success).toBe(true);
    });

    test(`[${app.id}] should verify container cleanup`, async () => {
      await new Promise((r) => setTimeout(r, 5000));
      const result = verifyContainerCleanup(app);
      expect(result.success).toBe(true);
      expect(result.containersFound).toHaveLength(0);
    });
  });
}
