import { expect, loginUser, test } from './fixtures/fixtures';

test.describe('App Store Browsing', () => {
  test('should display app store page with search and categories', async ({ page }) => {
    await loginUser(page);
    await page.goto('/app-store');

    await expect(page.getByRole('heading', { name: 'App Store' })).toBeVisible({ timeout: 30000 });
    await expect(page.getByPlaceholder('Search apps...').first()).toBeVisible({ timeout: 30000 });
  });

  test('should filter by category', async ({ page }) => {
    await loginUser(page);
    await page.goto('/app-store');

    await expect(page.getByRole('heading', { name: 'App Store' })).toBeVisible({ timeout: 30000 });

    // Category sidebar buttons are always rendered on desktop viewport.
    // Click the AI category to filter, then verify the page still works.
    await page.getByRole('button', { name: 'Ai' }).click();
    await expect(page.getByPlaceholder('Search apps...').first()).toBeVisible({ timeout: 30000 });
  });

  test('should show empty state when no apps match search', async ({ page }) => {
    await loginUser(page);
    await page.goto('/app-store');

    await expect(page.getByPlaceholder('Search apps...').first()).toBeVisible({ timeout: 30000 });
    await page.getByPlaceholder('Search apps...').first().fill('zzz-nonexistent-app-xyz');
    await expect(page.getByText('No app found')).toBeVisible({ timeout: 30000 });
  });
});
