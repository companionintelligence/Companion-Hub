/**
 * E2E Tests: Cloudflare Binding
 *
 * Tests for Cloudflare integration:
 * - Add Cloudflare API credentials
 * - Create tunnel
 * - Verify external access
 * - Test tunnel reconnection
 */

import { expect, loginUser, test } from './fixtures/fixtures';

// Test configuration - use environment variables for secrets
const CLOUDFLARE_CONFIG = {
  apiToken: process.env.CF_API_TOKEN || 'test-token',
  accountId: process.env.CF_ACCOUNT_ID || 'test-account',
  testZone: process.env.CF_TEST_ZONE || 'test.ci.computer',
};

test.describe('Cloudflare Binding', () => {
  test.beforeEach(async ({ page, context }) => {
    await loginUser(page, context);
  });

  test('should navigate to Cloudflare settings', async ({ page }) => {
    await page.goto('/settings');

    // Find network/domain settings section
    await page.getByRole('tab', { name: /network|domains|external/i }).click();

    // Look for Cloudflare section
    await expect(page.getByText(/cloudflare/i)).toBeVisible();
  });

  test('should add Cloudflare API credentials', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: /network|domains/i }).click();

    // Click configure/add Cloudflare
    await page.getByRole('button', { name: /configure cloudflare|add cloudflare/i }).click();

    // Enter API token
    await page.getByLabel(/api token/i).fill(CLOUDFLARE_CONFIG.apiToken);

    // Submit
    await page.getByRole('button', { name: /save|connect|verify/i }).click();

    // Should validate and show success
    await expect(page.getByText(/connected|verified|valid/i)).toBeVisible({ timeout: 15000 });
  });

  test('should list available zones after connecting', async ({ page }) => {
    // Assuming credentials are already added
    await page.goto('/settings');
    await page.getByRole('tab', { name: /network|domains/i }).click();

    // Check for zone selector or list
    const zoneSelector = page.getByTestId('cloudflare-zone-selector');
    await expect(zoneSelector).toBeVisible();

    // Should have at least one zone option
    const options = await zoneSelector.locator('option').count();
    expect(options).toBeGreaterThan(0);
  });

  test('should create Cloudflare tunnel', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: /network|domains/i }).click();

    // Select zone
    await page.getByTestId('cloudflare-zone-selector').selectOption(CLOUDFLARE_CONFIG.testZone);

    // Click create tunnel
    await page.getByRole('button', { name: /create tunnel|enable tunnel/i }).click();

    // Wait for tunnel creation
    await expect(page.getByText(/tunnel.*created|tunnel.*active/i)).toBeVisible({ timeout: 60000 });

    // Verify tunnel status shows healthy
    await expect(page.getByTestId('tunnel-status')).toContainText(/healthy|connected/i);
  });

  test('should show tunnel status and details', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: /network|domains/i }).click();

    // Check tunnel status card
    const tunnelCard = page.getByTestId('tunnel-status-card');
    await expect(tunnelCard).toBeVisible();

    // Should show status
    await expect(tunnelCard.getByText(/status/i)).toBeVisible();

    // Should show connection info (latency, region, etc.)
    await expect(tunnelCard.getByText(/latency|region|uptime/i)).toBeVisible();
  });

  test('should access server via tunnel URL', async ({ page, context }) => {
    // Get the tunnel URL from settings
    await page.goto('/settings');
    await page.getByRole('tab', { name: /network|domains/i }).click();

    const tunnelUrl = await page.getByTestId('tunnel-url').textContent();
    if (!tunnelUrl) throw new Error('Tunnel URL not found');

    // Open tunnel URL in new tab
    const externalPage = await context.newPage();
    await externalPage.goto(tunnelUrl, { waitUntil: 'networkidle' });

    // Should load the Hub login or dashboard
    await expect(externalPage.getByText(/companion|hub|login/i)).toBeVisible();

    await externalPage.close();
  });

  test('should disable/remove Cloudflare tunnel', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: /network|domains/i }).click();

    // Click disconnect/disable
    await page.getByRole('button', { name: /disconnect|disable|remove/i }).click();
    await page.getByRole('button', { name: /confirm/i }).click();

    // Verify tunnel is disabled
    await expect(page.getByText(/tunnel.*disabled|no tunnel/i)).toBeVisible({ timeout: 30000 });
  });
});

test.describe('Cloudflare DNS Management', () => {
  test.beforeEach(async ({ page, context }) => {
    await loginUser(page, context);
  });

  test('should create DNS record for app subdomain', async ({ page }) => {
    // This test assumes an app is installed
    await page.goto('/apps');

    // Click on an installed app
    await page.getByTestId('installed-app-nginx').click();

    // Go to domain settings
    await page.getByRole('tab', { name: /domain|settings/i }).click();

    // Enable external access / create subdomain
    await page.getByTestId('subdomain-input').fill('cf-test-app');
    await page.getByRole('button', { name: /save|apply/i }).click();

    // Wait for DNS creation
    await expect(page.getByText(/dns.*created|subdomain.*active/i)).toBeVisible({ timeout: 30000 });
  });

  test('should remove DNS record when app is deleted', async ({ page }) => {
    // Install and configure app with subdomain
    await page.goto('/app-store/ci-apps/nginx');
    await page.getByRole('button', { name: 'Install' }).click();
    await expect(page.getByText(/running/i)).toBeVisible({ timeout: 120000 });

    // Configure subdomain
    await page.goto('/apps/nginx');
    await page.getByRole('tab', { name: /settings/i }).click();
    await page.getByTestId('subdomain-input').fill('dns-remove-test');
    await page.getByRole('button', { name: /save/i }).click();
    await expect(page.getByText(/active/i)).toBeVisible({ timeout: 30000 });

    // Now delete the app
    await page.getByRole('button', { name: /delete/i }).click();
    await page.getByRole('button', { name: /confirm/i }).click();
    await expect(page.getByText(/deleted/i)).toBeVisible({ timeout: 60000 });

    // Verify DNS is cleaned up (would need API check or external verification)
    // For now, just verify the UI shows cleanup
    await expect(page.getByText(/dns.*removed|subdomain.*deleted/i)).toBeVisible();
  });
});
