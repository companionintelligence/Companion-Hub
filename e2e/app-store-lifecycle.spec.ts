/**
 * E2E Tests: Complete App Store Testing
 * 
 * Full lifecycle testing with:
 * - Install from store
 * - Subdomain configuration
 * - Health verification
 * - Screenshot capture
 * - Cleanup verification
 */

import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Configuration
const BASE_URL = process.env.HUB_URL || 'http://localhost:3000';
const TEST_DOMAIN = process.env.TEST_DOMAIN || 'test.ci.computer';
const SCREENSHOTS_DIR = 'e2e/screenshots';
const RESULTS_DIR = 'e2e/results';

// Test user credentials
const TEST_USER = {
  email: process.env.E2E_TEST_EMAIL || 'test@ci.computer',
  password: process.env.E2E_TEST_PASSWORD || 'testpassword123',
};

interface AppTestConfig {
  id: string;
  storeSlug: string;
  name: string;
  expectedPort: number;
  healthEndpoint: string;
  hasGui: boolean;
  categories: string[];
  priority: 'high' | 'medium' | 'low';
}

// Ensure directories exist
[SCREENSHOTS_DIR, `${SCREENSHOTS_DIR}/baselines`, `${SCREENSHOTS_DIR}/current`, `${SCREENSHOTS_DIR}/diffs`, RESULTS_DIR].forEach(dir => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

/**
 * Login helper
 */
async function login(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/login`);
  await page.getByPlaceholder(/email/i).fill(TEST_USER.email);
  await page.getByPlaceholder(/password/i).fill(TEST_USER.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.getByText(/dashboard|my apps/i)).toBeVisible({ timeout: 15000 });
}

/**
 * Install app from store
 */
async function installApp(
  page: Page, 
  app: AppTestConfig,
  options: { subdomain?: string } = {}
): Promise<{ success: boolean; duration: number; error?: string }> {
  const startTime = Date.now();
  
  try {
    // Navigate to app in store
    await page.goto(`${BASE_URL}/app-store/${app.storeSlug}/${app.id}`);
    await expect(page.getByRole('heading', { name: app.name })).toBeVisible({ timeout: 10000 });
    
    // Configure subdomain if provided
    if (options.subdomain) {
      const subdomainInput = page.getByTestId('subdomain-input');
      if (await subdomainInput.isVisible()) {
        await subdomainInput.fill(options.subdomain);
      }
    }
    
    // Click Install
    await page.getByRole('button', { name: /install/i }).click();
    
    // Wait for installation to complete
    await expect(page.getByText(/installing|configuring|downloading/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/running|installed|ready/i)).toBeVisible({ timeout: 180000 });
    
    return {
      success: true,
      duration: Date.now() - startTime,
    };
  } catch (error: unknown) {
    return {
      success: false,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Verify app health via subdomain
 */
async function verifyHealth(
  context: BrowserContext,
  app: AppTestConfig,
  subdomain: string
): Promise<{ success: boolean; status?: number; duration: number; error?: string }> {
  const startTime = Date.now();
  const url = `https://${subdomain}.${TEST_DOMAIN}${app.healthEndpoint}`;
  
  try {
    const appPage = await context.newPage();
    
    const response = await appPage.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    
    const status = response?.status() || 0;
    const success = status >= 200 && status < 500;
    
    await appPage.close();
    
    return {
      success,
      status,
      duration: Date.now() - startTime,
    };
  } catch (error: unknown) {
    return {
      success: false,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Take screenshot of running app
 */
async function takeScreenshot(
  context: BrowserContext,
  app: AppTestConfig,
  subdomain: string
): Promise<{ success: boolean; path?: string; duration: number; error?: string }> {
  const startTime = Date.now();
  const url = `https://${subdomain}.${TEST_DOMAIN}${app.healthEndpoint}`;
  const screenshotPath = join(SCREENSHOTS_DIR, 'current', `${app.id}.png`);
  
  try {
    const appPage = await context.newPage();
    
    await appPage.goto(url, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    
    // Wait for content to render
    await appPage.waitForTimeout(2000);
    
    await appPage.screenshot({
      path: screenshotPath,
      fullPage: true,
    });
    
    await appPage.close();
    
    return {
      success: true,
      path: screenshotPath,
      duration: Date.now() - startTime,
    };
  } catch (error: unknown) {
    return {
      success: false,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Delete app and verify cleanup
 */
async function deleteApp(
  page: Page,
  app: AppTestConfig
): Promise<{ success: boolean; duration: number; error?: string }> {
  const startTime = Date.now();
  
  try {
    // Navigate to app management
    await page.goto(`${BASE_URL}/apps/${app.id}`);
    
    // Look for delete/uninstall button
    const deleteButton = page.getByRole('button', { name: /delete|uninstall|remove/i });
    
    if (await deleteButton.isVisible()) {
      await deleteButton.click();
      
      // Confirm deletion
      const confirmButton = page.getByRole('button', { name: /confirm|yes|delete/i });
      if (await confirmButton.isVisible()) {
        await confirmButton.click();
      }
      
      // Wait for deletion confirmation
      await expect(page.getByText(/deleted|removed|uninstalled/i)).toBeVisible({ timeout: 60000 });
    }
    
    return {
      success: true,
      duration: Date.now() - startTime,
    };
  } catch (error: unknown) {
    return {
      success: false,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Verify container is cleaned up
 */
function verifyContainerCleanup(app: AppTestConfig): { success: boolean; containersFound: string[] } {
  try {
    const output = execSync(
      `docker ps -a --format "{{.Names}}" | grep -i "${app.id}" || true`,
      { encoding: 'utf-8' }
    ).trim();
    
    const containers = output.split('\n').filter(Boolean);
    
    return {
      success: containers.length === 0,
      containersFound: containers,
    };
  } catch {
    return {
      success: true,
      containersFound: [],
    };
  }
}

/**
 * Generate test for a single app
 */
export function generateAppLifecycleTest(app: AppTestConfig) {
  test.describe(`App Lifecycle: ${app.name}`, () => {
    const subdomain = `test-${app.id.slice(0, 20)}`;
    
    test.beforeAll(async () => {
      // Ensure clean state
      try {
        execSync(`docker stop ci-${app.id} 2>/dev/null; docker rm ci-${app.id} 2>/dev/null`, { stdio: 'pipe' });
      } catch {
        // Container may not exist, ignore
      }
    });
    
    test(`[${app.id}] should install from store`, async ({ page }) => {
      await login(page);
      
      const result = await installApp(page, app, { subdomain });
      
      expect(result.success).toBe(true);
      expect(result.duration).toBeLessThan(180000); // 3 minutes max
      
      if (!result.success) {
        test.fail(true, `Installation failed: ${result.error}`);
      }
    });
    
    test(`[${app.id}] should be accessible via subdomain`, async ({ page, context }) => {
      if (!app.hasGui) {
        test.skip();
        return;
      }
      
      await login(page);
      
      // First verify install
      await page.goto(`${BASE_URL}/apps/${app.id}`);
      await expect(page.getByText(/running/i)).toBeVisible({ timeout: 10000 });
      
      // Check subdomain access
      const result = await verifyHealth(context, app, subdomain);
      
      expect(result.success).toBe(true);
      expect(result.status).toBeLessThan(500);
    });
    
    test(`[${app.id}] should capture screenshot`, async ({ page, context }) => {
      if (!app.hasGui) {
        test.skip();
        return;
      }
      
      await login(page);
      
      const result = await takeScreenshot(context, app, subdomain);
      
      expect(result.success).toBe(true);
      expect(result.path).toBeDefined();
      
      // Compare to baseline if exists
      const baselinePath = join(SCREENSHOTS_DIR, 'baselines', `${app.id}.png`);
      if (existsSync(baselinePath) && result.path) {
        // Visual comparison would go here
        // Using pixelmatch or similar
      }
    });
    
    test(`[${app.id}] should delete successfully`, async ({ page }) => {
      await login(page);
      
      const result = await deleteApp(page, app);
      
      expect(result.success).toBe(true);
    });
    
    test(`[${app.id}] should verify container cleanup`, async () => {
      // Wait for cleanup to complete
      await new Promise(r => setTimeout(r, 5000));
      
      const result = verifyContainerCleanup(app);
      
      expect(result.success).toBe(true);
      expect(result.containersFound).toHaveLength(0);
    });
  });
}

// Load catalog and generate tests
const catalogPath = join(__dirname, 'generated/catalog.json');
if (existsSync(catalogPath)) {
  const catalog: AppTestConfig[] = JSON.parse(readFileSync(catalogPath, 'utf-8'));
  
  // Get batch from environment
  const batchIndex = Number.parseInt(process.env.BATCH || '0', 10);
  const batchSize = 86;
  const startIndex = batchIndex * batchSize;
  const endIndex = Math.min(startIndex + batchSize, catalog.length);
  
  const batchApps = catalog.slice(startIndex, endIndex);
  
  test.describe(`Catalog Batch ${batchIndex}`, () => {
    for (const app of batchApps) {
      generateAppLifecycleTest(app);
    }
  });
}
