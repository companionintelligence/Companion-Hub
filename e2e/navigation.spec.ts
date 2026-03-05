import { expect, loginUser, test } from './fixtures/fixtures';

test.describe('Navigation', () => {
  test('should navigate to all main pages', async ({ page }) => {
    await loginUser(page);

    // Dashboard (already there after login) — data loads asynchronously
    await expect(page.getByText('Disk space')).toBeVisible({ timeout: 15000 });

    // App Store
    await page.getByRole('link', { name: 'Store' }).click();
    await page.waitForURL(/\/app-store/);
    await expect(page.getByRole('heading', { name: 'App Store' })).toBeVisible({ timeout: 15000 });

    // Settings
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForURL(/\/settings/);
    await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible({ timeout: 15000 });

    // Back to Dashboard
    await page.getByRole('link', { name: 'Home' }).click();
    await page.waitForURL(/\/dashboard/);
    await expect(page.getByText('Disk space')).toBeVisible({ timeout: 15000 });
  });

  test('should have working logo link to dashboard', async ({ page }) => {
    await loginUser(page);
    await page.goto('/settings');
    await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible({ timeout: 15000 });

    await page.getByRole('link', { name: 'Companion Intelligence Logo' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText('Disk space')).toBeVisible({ timeout: 15000 });
  });

  test('should logout', async ({ page }) => {
    await loginUser(page);

    await page.getByRole('button', { name: 'Logout' }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });
});
