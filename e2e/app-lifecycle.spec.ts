/**
 * E2E Tests: App Store & Container Lifecycle
 *
 * Tests for the complete app lifecycle:
 * - Install app from store
 * - Create subdomain
 * - Verify app is running via subdomain
 * - Screenshot verification
 * - Delete app and verify cleanup
 */

import { expect, installApp, loginUser, test } from './fixtures/fixtures';
import { execSync } from 'child_process';

// Test app configuration
const TEST_APP = {
  storeSlug: 'ci-apps',
  appId: 'nginx', // Simple nginx app for testing
  appName: 'Nginx',
  containerPrefix: 'ci-nginx',
};

test.describe('App Lifecycle - Full Journey', () => {
  test.beforeEach(async ({ page, context }) => {
    await loginUser(page, context);
  });

  test('should install app from store', async ({ page }) => {
    // Navigate to app store
    await page.goto('/app-store');
    await expect(page.getByPlaceholder('Search')).toBeVisible();

    // Search for test app
    await page.getByPlaceholder('Search').fill(TEST_APP.appName);

    // Click on app card
    await page.getByTestId(`app-card-${TEST_APP.appId}`).click();

    // Verify app details page
    await expect(page.getByRole('heading', { name: TEST_APP.appName })).toBeVisible();

    // Click Install
    await page.getByRole('button', { name: 'Install' }).click();

    // Wait for installation dialog or progress
    await expect(page.getByText(/installing|configuring/i)).toBeVisible({ timeout: 10000 });

    // Wait for completion
    await expect(page.getByText(/running|installed/i)).toBeVisible({ timeout: 120000 });
  });

  test('should create subdomain for installed app', async ({ page }) => {
    // First install the app
    await installApp(page, TEST_APP.storeSlug, TEST_APP.appId);

    // Navigate to app settings
    await page.goto(`/apps/${TEST_APP.appId}`);
    await page.getByRole('tab', { name: 'Settings' }).click();

    // Find subdomain/domain settings
    await page.getByTestId('subdomain-input').fill('test-nginx');
    await page.getByRole('button', { name: /save|apply/i }).click();

    // Wait for DNS propagation confirmation
    await expect(page.getByText(/domain.*active|subdomain.*ready/i)).toBeVisible({ timeout: 60000 });
  });

  test('should access app via subdomain and take screenshot', async ({ page, context }) => {
    // Install and configure subdomain
    await installApp(page, TEST_APP.storeSlug, TEST_APP.appId, {
      domain: 'test-nginx',
    });

    // Create new page to access subdomain
    const appPage = await context.newPage();

    // Access via subdomain (adjust domain pattern for your setup)
    const subdomainUrl = `https://test-nginx.${process.env.TEST_DOMAIN || 'test.ci.computer'}`;

    await appPage.goto(subdomainUrl, { waitUntil: 'networkidle' });

    // Verify page loaded (nginx default page has specific content)
    await expect(appPage.locator('body')).not.toBeEmpty();

    // Take screenshot for verification
    const screenshot = await appPage.screenshot({
      path: `./e2e/screenshots/app-${TEST_APP.appId}-running.png`,
      fullPage: true,
    });

    expect(screenshot).toBeTruthy();

    await appPage.close();
  });

  test('should show app as running in dashboard', async ({ page }) => {
    // Install app
    await installApp(page, TEST_APP.storeSlug, TEST_APP.appId);

    // Go to my apps / dashboard
    await page.goto('/apps');

    // Find installed app
    const appCard = page.getByTestId(`installed-app-${TEST_APP.appId}`);
    await expect(appCard).toBeVisible();

    // Check status indicator
    await expect(appCard.getByText(/running/i)).toBeVisible();
  });

  test('should view app logs', async ({ page }) => {
    // Install app
    await installApp(page, TEST_APP.storeSlug, TEST_APP.appId);

    // Navigate to app
    await page.goto(`/apps/${TEST_APP.appId}`);

    // Click logs tab
    await page.getByRole('tab', { name: /logs/i }).click();

    // Verify logs are displayed
    await expect(page.getByTestId('app-logs-container')).toBeVisible();

    // Logs should have some content
    const logsContent = await page.getByTestId('app-logs-container').textContent();
    expect(logsContent?.length).toBeGreaterThan(0);
  });

  test('should stop and start app', async ({ page }) => {
    // Install app
    await installApp(page, TEST_APP.storeSlug, TEST_APP.appId);

    // Navigate to app
    await page.goto(`/apps/${TEST_APP.appId}`);

    // Stop the app
    await page.getByRole('button', { name: /stop/i }).click();
    await page.getByRole('button', { name: /confirm/i }).click();

    // Verify stopped
    await expect(page.getByText(/stopped/i)).toBeVisible({ timeout: 30000 });

    // Start the app
    await page.getByRole('button', { name: /start/i }).click();

    // Verify running
    await expect(page.getByText(/running/i)).toBeVisible({ timeout: 30000 });
  });
});

test.describe('App Deletion & Cleanup', () => {
  test.beforeEach(async ({ page, context }) => {
    await loginUser(page, context);
  });

  test('should delete app and confirm cleanup', async ({ page }) => {
    // Install app first
    await installApp(page, TEST_APP.storeSlug, TEST_APP.appId, {
      domain: 'delete-test',
    });

    // Navigate to app
    await page.goto(`/apps/${TEST_APP.appId}`);

    // Get container name before deletion for verification
    const containerName = `${TEST_APP.containerPrefix}`;

    // Click delete/uninstall
    await page.getByRole('button', { name: /delete|uninstall|remove/i }).click();

    // Confirm deletion
    await page.getByRole('button', { name: /confirm|yes|delete/i }).click();

    // Wait for deletion
    await expect(page.getByText(/deleted|removed|uninstalled/i)).toBeVisible({ timeout: 60000 });

    // Verify app no longer in installed apps
    await page.goto('/apps');
    await expect(page.getByTestId(`installed-app-${TEST_APP.appId}`)).not.toBeVisible();

    // Verify container is gone (via API or direct check)
    // This would need a helper function that checks Docker
  });

  test('should verify DNS record removed after deletion', async ({ page }) => {
    const subdomain = 'dns-cleanup-test';

    // Install with subdomain
    await installApp(page, TEST_APP.storeSlug, TEST_APP.appId, {
      domain: subdomain,
    });

    // Delete the app
    await page.goto(`/apps/${TEST_APP.appId}`);
    await page.getByRole('button', { name: /delete|uninstall/i }).click();
    await page.getByRole('button', { name: /confirm/i }).click();
    await expect(page.getByText(/deleted/i)).toBeVisible({ timeout: 60000 });

    // Wait for DNS propagation
    await page.waitForTimeout(5000);

    // Try to access subdomain - should fail
    const response = await page.request.get(`https://${subdomain}.${process.env.TEST_DOMAIN || 'test.ci.computer'}`, { failOnStatusCode: false });

    // Should get error (502, 503, or connection refused)
    expect([502, 503, 504, 0].includes(response.status()) || !response.ok()).toBeTruthy();
  });

  test('should show app as not installed in store after deletion', async ({ page }) => {
    // Install app
    await installApp(page, TEST_APP.storeSlug, TEST_APP.appId);

    // Delete app
    await page.goto(`/apps/${TEST_APP.appId}`);
    await page.getByRole('button', { name: /delete|uninstall/i }).click();
    await page.getByRole('button', { name: /confirm/i }).click();
    await expect(page.getByText(/deleted/i)).toBeVisible({ timeout: 60000 });

    // Navigate to app store and find the app
    await page.goto(`/app-store/${TEST_APP.storeSlug}/${TEST_APP.appId}`);

    // Should show Install button (not Running/Installed)
    await expect(page.getByRole('button', { name: 'Install' })).toBeVisible();
  });
});

test.describe('Multi-App Scenarios', () => {
  const MULTI_APPS = [
    { storeSlug: 'ci-apps', appId: 'nginx', domain: 'multi-nginx' },
    { storeSlug: 'ci-apps', appId: 'whoami', domain: 'multi-whoami' },
  ];

  test.beforeEach(async ({ page, context }) => {
    await loginUser(page, context);
  });

  test('should install multiple apps with unique subdomains', async ({ page }) => {
    for (const app of MULTI_APPS) {
      await installApp(page, app.storeSlug, app.appId, { domain: app.domain });
    }

    // Verify all apps are running
    await page.goto('/apps');

    for (const app of MULTI_APPS) {
      await expect(page.getByTestId(`installed-app-${app.appId}`)).toBeVisible();
    }
  });

  test('should access each app via unique subdomain', async ({ page, context }) => {
    // Install all apps
    for (const app of MULTI_APPS) {
      await installApp(page, app.storeSlug, app.appId, { domain: app.domain });
    }

    // Test each subdomain
    for (const app of MULTI_APPS) {
      const appPage = await context.newPage();
      const url = `https://${app.domain}.${process.env.TEST_DOMAIN || 'test.ci.computer'}`;

      await appPage.goto(url, { waitUntil: 'networkidle' });
      await expect(appPage.locator('body')).not.toBeEmpty();

      // Screenshot each
      await appPage.screenshot({
        path: `./e2e/screenshots/multi-app-${app.appId}.png`,
      });

      await appPage.close();
    }
  });

  test('should delete one app without affecting others', async ({ page, context }) => {
    // Install all apps
    for (const app of MULTI_APPS) {
      await installApp(page, app.storeSlug, app.appId, { domain: app.domain });
    }

    // Delete first app
    await page.goto(`/apps/${MULTI_APPS[0].appId}`);
    await page.getByRole('button', { name: /delete/i }).click();
    await page.getByRole('button', { name: /confirm/i }).click();
    await expect(page.getByText(/deleted/i)).toBeVisible({ timeout: 60000 });

    // Verify second app still accessible
    const appPage = await context.newPage();
    const url = `https://${MULTI_APPS[1].domain}.${process.env.TEST_DOMAIN || 'test.ci.computer'}`;

    await appPage.goto(url, { waitUntil: 'networkidle' });
    await expect(appPage.locator('body')).not.toBeEmpty();

    await appPage.close();
  });
});
