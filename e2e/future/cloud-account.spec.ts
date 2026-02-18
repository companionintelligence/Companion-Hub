/**
 * E2E Tests: Cloud Account
 *
 * Tests for CI Cloud account lifecycle:
 * - Create cloud account
 * - Link server to cloud
 * - Remote access via cloud
 * - Account management
 */

import { expect, loginUser, test } from './fixtures/fixtures';

const CLOUD_CONFIG = {
  baseUrl: process.env.CLOUD_URL || 'https://cloud.ci.computer',
  testEmail: process.env.TEST_EMAIL || 'e2e-test@ci.computer',
  testPassword: process.env.TEST_PASSWORD || 'TestPass123!',
};

test.describe('Cloud Account Creation', () => {
  test('should navigate to cloud registration from Hub', async ({ page, context }) => {
    await loginUser(page, context);

    await page.goto('/settings');
    await page.getByRole('tab', { name: /cloud|account/i }).click();

    // Should see option to connect cloud account
    await expect(page.getByText(/connect.*cloud|link.*account/i)).toBeVisible();

    // Click to register/connect
    await page.getByRole('button', { name: /create.*account|register|sign up/i }).click();

    // Should navigate to cloud registration
    await expect(page).toHaveURL(new RegExp(`${CLOUD_CONFIG.baseUrl}.*register`));
  });

  test('should register new cloud account', async ({ page }) => {
    await page.goto(`${CLOUD_CONFIG.baseUrl}/register`);

    // Fill registration form
    await page.getByLabel(/email/i).fill(CLOUD_CONFIG.testEmail);
    await page
      .getByLabel(/password/i)
      .first()
      .fill(CLOUD_CONFIG.testPassword);
    await page.getByLabel(/confirm.*password/i).fill(CLOUD_CONFIG.testPassword);

    // Accept terms if present
    const termsCheckbox = page.getByLabel(/terms|agree/i);
    if (await termsCheckbox.isVisible()) {
      await termsCheckbox.check();
    }

    // Submit
    await page.getByRole('button', { name: /register|sign up|create/i }).click();

    // Should show success or verification message
    await expect(page.getByText(/verification.*sent|check.*email|account.*created/i)).toBeVisible({ timeout: 15000 });
  });

  test('should login to cloud account', async ({ page }) => {
    await page.goto(`${CLOUD_CONFIG.baseUrl}/login`);

    await page.getByLabel(/email/i).fill(CLOUD_CONFIG.testEmail);
    await page.getByLabel(/password/i).fill(CLOUD_CONFIG.testPassword);

    await page.getByRole('button', { name: /login|sign in/i }).click();

    // Should redirect to dashboard
    await expect(page.getByText(/dashboard|my servers|welcome/i)).toBeVisible({ timeout: 15000 });
  });
});

test.describe('Server Linking', () => {
  test.beforeEach(async ({ page, context }) => {
    await loginUser(page, context);
  });

  test('should link local server to cloud account', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: /cloud/i }).click();

    // Click link to cloud
    await page.getByRole('button', { name: /link|connect.*cloud/i }).click();

    // Should show linking dialog/flow
    await expect(page.getByText(/enter.*code|login.*cloud|authorize/i)).toBeVisible();

    // Enter cloud credentials or code
    const emailInput = page.getByLabel(/email/i);
    if (await emailInput.isVisible()) {
      await emailInput.fill(CLOUD_CONFIG.testEmail);
      await page.getByLabel(/password/i).fill(CLOUD_CONFIG.testPassword);
      await page.getByRole('button', { name: /login|connect/i }).click();
    }

    // Wait for linking
    await expect(page.getByText(/linked|connected|synced/i)).toBeVisible({ timeout: 30000 });
  });

  test('should show server in cloud dashboard after linking', async ({ page, context }) => {
    // Assume server is linked
    await page.goto('/settings');
    await page.getByRole('tab', { name: /cloud/i }).click();

    // Get server ID or name
    const serverName = await page.getByTestId('server-name').textContent();
    if (!serverName) throw new Error('Server name not found');

    // Open cloud dashboard
    const cloudPage = await context.newPage();
    await cloudPage.goto(`${CLOUD_CONFIG.baseUrl}/login`);
    await cloudPage.getByLabel(/email/i).fill(CLOUD_CONFIG.testEmail);
    await cloudPage.getByLabel(/password/i).fill(CLOUD_CONFIG.testPassword);
    await cloudPage.getByRole('button', { name: /login/i }).click();

    // Navigate to servers list
    await cloudPage.goto(`${CLOUD_CONFIG.baseUrl}/servers`);

    // Verify server appears
    await expect(cloudPage.getByText(serverName)).toBeVisible();

    await cloudPage.close();
  });

  test('should show sync status', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: /cloud/i }).click();

    // Should show last sync time
    await expect(page.getByText(/last.*sync|synced.*ago/i)).toBeVisible();

    // Should show sync status indicator
    await expect(page.getByTestId('cloud-sync-status')).toBeVisible();
  });

  test('should manually trigger sync', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: /cloud/i }).click();

    // Click sync button
    await page.getByRole('button', { name: /sync.*now|refresh/i }).click();

    // Should show syncing indicator
    await expect(page.getByText(/syncing|updating/i)).toBeVisible();

    // Wait for completion
    await expect(page.getByText(/synced|up to date/i)).toBeVisible({ timeout: 30000 });
  });
});

test.describe('Remote Access via Cloud', () => {
  test('should access server remotely through cloud portal', async ({ page }) => {
    // Login to cloud
    await page.goto(`${CLOUD_CONFIG.baseUrl}/login`);
    await page.getByLabel(/email/i).fill(CLOUD_CONFIG.testEmail);
    await page.getByLabel(/password/i).fill(CLOUD_CONFIG.testPassword);
    await page.getByRole('button', { name: /login/i }).click();

    // Navigate to servers
    await page.goto(`${CLOUD_CONFIG.baseUrl}/servers`);

    // Click on test server
    await page.getByTestId('server-card').first().click();

    // Click connect/access
    await page.getByRole('button', { name: /connect|access|open/i }).click();

    // Should establish tunnel and show Hub
    await expect(page.getByText(/companion|hub|dashboard/i)).toBeVisible({ timeout: 60000 });
  });

  test('should show server status in cloud dashboard', async ({ page }) => {
    // Login to cloud
    await page.goto(`${CLOUD_CONFIG.baseUrl}/login`);
    await page.getByLabel(/email/i).fill(CLOUD_CONFIG.testEmail);
    await page.getByLabel(/password/i).fill(CLOUD_CONFIG.testPassword);
    await page.getByRole('button', { name: /login/i }).click();

    // Navigate to servers
    await page.goto(`${CLOUD_CONFIG.baseUrl}/servers`);

    // Check server status
    const serverCard = page.getByTestId('server-card').first();
    await expect(serverCard.getByText(/online|connected/i)).toBeVisible();
  });
});

test.describe('Account Management', () => {
  test('should unlink server from cloud', async ({ page, context }) => {
    await loginUser(page, context);

    await page.goto('/settings');
    await page.getByRole('tab', { name: /cloud/i }).click();

    // Click unlink
    await page.getByRole('button', { name: /unlink|disconnect/i }).click();
    await page.getByRole('button', { name: /confirm/i }).click();

    // Verify unlinked
    await expect(page.getByText(/not.*linked|disconnected/i)).toBeVisible({ timeout: 15000 });
  });

  test('should delete cloud account', async ({ page }) => {
    // Login to cloud
    await page.goto(`${CLOUD_CONFIG.baseUrl}/login`);
    await page.getByLabel(/email/i).fill(CLOUD_CONFIG.testEmail);
    await page.getByLabel(/password/i).fill(CLOUD_CONFIG.testPassword);
    await page.getByRole('button', { name: /login/i }).click();

    // Navigate to account settings
    await page.goto(`${CLOUD_CONFIG.baseUrl}/settings/account`);

    // Click delete account
    await page.getByRole('button', { name: /delete.*account/i }).click();

    // Confirm with password
    await page.getByLabel(/password/i).fill(CLOUD_CONFIG.testPassword);
    await page.getByRole('button', { name: /confirm.*delete|delete.*account/i }).click();

    // Should redirect to goodbye page or homepage
    await expect(page.getByText(/deleted|goodbye/i)).toBeVisible({ timeout: 15000 });
  });
});
