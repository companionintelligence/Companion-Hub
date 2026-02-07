/**
 * E2E Tests: Tailscale Binding
 *
 * Tests for Tailscale integration:
 * - Connect to Tailscale
 * - Verify IP assignment
 * - Test MagicDNS access
 * - Tailscale Serve/Funnel setup
 */

import { expect, loginUser, test } from './fixtures/fixtures';

// Test configuration
const TAILSCALE_CONFIG = {
  authKey: process.env.TS_AUTH_KEY || 'test-key',
  tailnet: process.env.TS_TAILNET || 'test.ts.net',
};

test.describe('Tailscale Binding', () => {
  test.beforeEach(async ({ page, context }) => {
    await loginUser(page, context);
  });

  test('should navigate to Tailscale settings', async ({ page }) => {
    await page.goto('/settings');

    // Find network settings
    await page.getByRole('tab', { name: /network|vpn|remote/i }).click();

    // Look for Tailscale section
    await expect(page.getByText(/tailscale/i)).toBeVisible();
  });

  test('should connect to Tailscale with auth key', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: /network/i }).click();

    // Click connect Tailscale
    await page.getByRole('button', { name: /connect tailscale|add tailscale/i }).click();

    // Enter auth key
    await page.getByLabel(/auth key/i).fill(TAILSCALE_CONFIG.authKey);

    // Submit
    await page.getByRole('button', { name: /connect|login/i }).click();

    // Wait for connection
    await expect(page.getByText(/connected|authenticated/i)).toBeVisible({ timeout: 30000 });
  });

  test('should display Tailscale IP after connection', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: /network/i }).click();

    // Check for Tailscale status card
    const tailscaleCard = page.getByTestId('tailscale-status');
    await expect(tailscaleCard).toBeVisible();

    // Should show 100.x.x.x IP
    await expect(tailscaleCard.getByText(/100\.\d+\.\d+\.\d+/)).toBeVisible();
  });

  test('should display Tailscale hostname', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: /network/i }).click();

    const tailscaleCard = page.getByTestId('tailscale-status');

    // Should show hostname.tailnet format
    await expect(tailscaleCard.getByText(new RegExp(`\\w+\\.${TAILSCALE_CONFIG.tailnet}`))).toBeVisible();
  });

  test('should access server via MagicDNS', async ({ page, context }) => {
    // Get the MagicDNS hostname
    await page.goto('/settings');
    await page.getByRole('tab', { name: /network/i }).click();

    const hostnameElement = page.getByTestId('tailscale-hostname');
    const hostname = await hostnameElement.textContent();
    expect(hostname).toBeTruthy();

    // Try to access via MagicDNS (this would need to be run from tailnet)
    if (process.env.RUN_TAILSCALE_TESTS === 'true') {
      const tailnetPage = await context.newPage();
      await tailnetPage.goto(`http://${hostname}`, { waitUntil: 'networkidle' });

      // Should load Hub
      await expect(tailnetPage.getByText(/companion|hub/i)).toBeVisible();

      await tailnetPage.close();
    }
  });

  test('should enable Tailscale Serve for HTTPS', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: /network/i }).click();

    // Find Tailscale Serve toggle/button
    await page.getByRole('button', { name: /enable.*serve|tailscale serve/i }).click();

    // Confirm if needed
    const confirmBtn = page.getByRole('button', { name: /confirm|enable/i });
    if (await confirmBtn.isVisible()) {
      await confirmBtn.click();
    }

    // Wait for Serve to be enabled
    await expect(page.getByText(/serve.*enabled|https.*active/i)).toBeVisible({ timeout: 30000 });

    // Should show HTTPS URL
    await expect(page.getByText(/https:\/\/.*\.ts\.net/)).toBeVisible();
  });

  test('should access via Tailscale Serve HTTPS', async ({ page, context }) => {
    // Get the Serve URL
    await page.goto('/settings');
    await page.getByRole('tab', { name: /network/i }).click();

    const serveUrl = await page.getByTestId('tailscale-serve-url').textContent();
    expect(serveUrl).toMatch(/^https:\/\//);

    // Access via HTTPS (requires being on tailnet)
    if (process.env.RUN_TAILSCALE_TESTS === 'true') {
      const servePage = await context.newPage();
      await servePage.goto(serveUrl!, { waitUntil: 'networkidle' });

      // Verify HTTPS is working
      await expect(servePage.getByText(/companion|hub/i)).toBeVisible();

      // Verify it's actually HTTPS
      expect(servePage.url()).toMatch(/^https:\/\//);

      await servePage.close();
    }
  });

  test('should enable Tailscale Funnel for public access (optional)', async ({ page }) => {
    // Skip if funnel is not available or not desired
    test.skip(process.env.SKIP_FUNNEL_TESTS === 'true', 'Funnel tests skipped');

    await page.goto('/settings');
    await page.getByRole('tab', { name: /network/i }).click();

    // Enable Funnel
    await page.getByRole('button', { name: /enable.*funnel|public access/i }).click();

    // Warning confirmation
    await page.getByRole('button', { name: /confirm|understand/i }).click();

    // Wait for Funnel to be enabled
    await expect(page.getByText(/funnel.*enabled|public.*active/i)).toBeVisible({ timeout: 30000 });

    // Should show public URL
    await expect(page.getByTestId('funnel-url')).toBeVisible();
  });

  test('should disconnect from Tailscale', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: /network/i }).click();

    // Click disconnect
    await page.getByRole('button', { name: /disconnect|logout|remove/i }).click();
    await page.getByRole('button', { name: /confirm/i }).click();

    // Verify disconnected
    await expect(page.getByText(/disconnected|not connected/i)).toBeVisible({ timeout: 30000 });
  });
});

test.describe('Tailscale + App Integration', () => {
  test.beforeEach(async ({ page, context }) => {
    await loginUser(page, context);
  });

  test('should expose app via Tailscale Serve', async ({ page }) => {
    // Assuming Tailscale is connected and an app is installed
    await page.goto('/apps/nginx');
    await page.getByRole('tab', { name: /settings|domain/i }).click();

    // Enable Tailscale access for app
    await page.getByLabel(/tailscale.*access|expose.*tailscale/i).check();
    await page.getByRole('button', { name: /save/i }).click();

    // Should show tailscale URL for app
    await expect(page.getByText(/\.ts\.net.*nginx|nginx.*\.ts\.net/i)).toBeVisible({ timeout: 30000 });
  });

  test('should use Tailscale for app-to-app communication', async ({ page }) => {
    // This would test internal networking
    // Install two apps that can communicate

    // Navigate to network settings of an app
    await page.goto('/apps/nginx');
    await page.getByRole('tab', { name: /network/i }).click();

    // Check for internal network options
    await expect(page.getByText(/internal.*network|app.*network/i)).toBeVisible();
  });
});
