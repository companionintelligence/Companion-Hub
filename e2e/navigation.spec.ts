import { expect, loginUser, test } from './fixtures/fixtures';

test.describe('Navigation', () => {
  test('should navigate to all main pages', async ({ page }) => {
    await loginUser(page);

    // Dashboard (already there after login)
    await expect(page.getByText('Disk space')).toBeVisible();

    // My Apps
    await page.getByRole('link', { name: 'My Apps' }).click();
    await expect(page).toHaveURL(/\/apps/);

    // App Store
    await page.getByRole('link', { name: 'App Store' }).click();
    await expect(page).toHaveURL(/\/app-store/);
    await expect(page.getByRole('heading', { name: 'App Store' })).toBeVisible();

    // Settings
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByRole('tablist')).toBeVisible();

    // Back to Dashboard
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText('Disk space')).toBeVisible();
  });

  test('should have working logo link to dashboard', async ({ page }) => {
    await loginUser(page);
    await page.goto('/settings');

    await page.getByRole('link', { name: 'Companion Intelligence Logo' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('should logout', async ({ page }) => {
    await loginUser(page);

    await page.getByRole('button', { name: 'Logout' }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });
});
