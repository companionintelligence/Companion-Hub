/**
 * E2E Tests: First-Time User Experience (FTUE)
 *
 * Tests for new user onboarding:
 * - Initial setup wizard
 * - Admin account creation
 * - Basic configuration
 * - Welcome flow
 */

import { expect, test } from './fixtures/fixtures';
import { clearDatabase, seedOrganization } from './helpers/db';

test.describe('First-Time User Experience', () => {
  test.beforeEach(async () => {
    // Clear everything for fresh install experience
    await clearDatabase();
  });

  test('should show setup wizard on first access', async ({ page }) => {
    await page.goto('/');

    // Should redirect to setup/register page
    await expect(page).toHaveURL(/register|setup|onboarding/);

    // Should show welcome message
    await expect(page.getByText(/welcome|get started|set up/i)).toBeVisible();
  });

  test('should complete registration with new admin account', async ({ page }) => {
    await page.goto('/');

    // Should be on registration
    await expect(page).toHaveURL(/register/);

    // Fill registration form
    await page.getByPlaceholder('you@example.com').fill('admin@test.local');
    await page.getByPlaceholder('Enter your password').fill('SecurePass123!');
    await page.getByPlaceholder('Confirm your password').fill('SecurePass123!');

    // Submit
    await page.getByRole('button', { name: /register|create/i }).click();

    // Should show welcome/onboarding screen
    await expect(page.getByText(/welcome|thanks|companion hub/i)).toBeVisible({ timeout: 10000 });
  });

  test('should show welcome wizard after registration', async ({ page }) => {
    await page.goto('/');

    // Complete registration
    await page.getByPlaceholder('you@example.com').fill('admin@test.local');
    await page.getByPlaceholder('Enter your password').fill('SecurePass123!');
    await page.getByPlaceholder('Confirm your password').fill('SecurePass123!');
    await page.getByRole('button', { name: /register/i }).click();

    // Should show welcome wizard
    await expect(page.getByRole('heading', { name: /welcome|companion/i })).toBeVisible();

    // Should have continue/next button
    await expect(page.getByRole('button', { name: /continue|next|save/i })).toBeVisible();
  });

  test('should configure basic settings in welcome wizard', async ({ page }) => {
    await page.goto('/');

    // Complete registration
    await page.getByPlaceholder('you@example.com').fill('admin@test.local');
    await page.getByPlaceholder('Enter your password').fill('SecurePass123!');
    await page.getByPlaceholder('Confirm your password').fill('SecurePass123!');
    await page.getByRole('button', { name: /register/i }).click();

    // Wait for welcome screen
    await expect(page.getByText(/welcome/i)).toBeVisible();

    // Configure any initial settings if present
    // (hostname, timezone, etc.)
    const hostnameInput = page.getByLabel(/hostname|server name/i);
    if (await hostnameInput.isVisible()) {
      await hostnameInput.fill('test-ci-server');
    }

    const timezoneSelect = page.getByLabel(/timezone/i);
    if (await timezoneSelect.isVisible()) {
      await timezoneSelect.selectOption('America/Los_Angeles');
    }

    // Complete wizard
    await page.getByRole('button', { name: /save.*enter|finish|complete/i }).click();

    // Should be on dashboard
    await expect(page.getByText(/disk space|dashboard|apps/i)).toBeVisible();
  });

  test('should access dashboard after setup', async ({ page }) => {
    await page.goto('/');

    // Complete registration
    await page.getByPlaceholder('you@example.com').fill('admin@test.local');
    await page.getByPlaceholder('Enter your password').fill('SecurePass123!');
    await page.getByPlaceholder('Confirm your password').fill('SecurePass123!');
    await page.getByRole('button', { name: /register/i }).click();

    // Complete welcome
    await expect(page.getByText(/welcome/i)).toBeVisible();
    await page.getByRole('button', { name: /save|enter|continue/i }).click();

    // Should show dashboard with system info
    await expect(page.getByText(/disk space/i)).toBeVisible();
    await expect(page.getByText(/cpu|memory|ram/i)).toBeVisible();
  });

  test('should show system health on dashboard', async ({ page }) => {
    // Seed organization and create user
    await seedOrganization();
    const { createTestUser, loginUser } = await import('./fixtures/fixtures');
    await createTestUser();
    await loginUser(page, {} as any);

    // Dashboard should show health metrics
    await expect(page.getByText(/disk space/i)).toBeVisible();

    // Should show usage bars/indicators
    await expect(page.getByTestId('disk-usage')).toBeVisible();
    await expect(page.getByTestId('memory-usage')).toBeVisible();
    await expect(page.getByTestId('cpu-usage')).toBeVisible();
  });
});

test.describe('FTUE - Security Setup', () => {
  test.beforeEach(async () => {
    await clearDatabase();
  });

  test('should show security warning for HTTP access', async ({ page }) => {
    await page.goto('/');

    // Complete minimal setup
    await page.getByPlaceholder('you@example.com').fill('admin@test.local');
    await page.getByPlaceholder('Enter your password').fill('SecurePass123!');
    await page.getByPlaceholder('Confirm your password').fill('SecurePass123!');
    await page.getByRole('button', { name: /register/i }).click();

    // After login, should see security warning if on HTTP
    // (this would only show in non-localhost environments)
    const securityWarning = page.getByText(/insecure|https recommended/i);
    if (await securityWarning.isVisible({ timeout: 5000 }).catch(() => false)) {
      // Dismiss warning
      await page.getByRole('button', { name: /close|dismiss/i }).click();
    }
  });

  test('should prompt for 2FA setup (optional)', async ({ page }) => {
    await page.goto('/');

    // Complete registration
    await page.getByPlaceholder('you@example.com').fill('admin@test.local');
    await page.getByPlaceholder('Enter your password').fill('SecurePass123!');
    await page.getByPlaceholder('Confirm your password').fill('SecurePass123!');
    await page.getByRole('button', { name: /register/i }).click();

    // Complete welcome
    await page.getByRole('button', { name: /save|enter/i }).click();

    // Navigate to security settings
    await page.goto('/settings');
    await page.getByRole('tab', { name: /security/i }).click();

    // Should see 2FA option
    await expect(page.getByText(/two-factor|2fa|authenticator/i)).toBeVisible();
  });
});

test.describe('FTUE - Network Configuration', () => {
  test('should show network setup options', async ({ page }) => {
    await clearDatabase();
    await seedOrganization();
    const { createTestUser, loginUser } = await import('./fixtures/fixtures');
    await createTestUser();
    await loginUser(page, {} as any);

    // Go to settings
    await page.goto('/settings');
    await page.getByRole('tab', { name: /network|domains/i }).click();

    // Should show external access options
    await expect(page.getByText(/cloudflare|tailscale|external/i)).toBeVisible();
  });
});
