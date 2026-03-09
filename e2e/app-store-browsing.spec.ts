import { expect, loginUser, test } from './fixtures/fixtures';

test.describe('App Store Browsing', () => {
  test('should display app store page with search and categories', async ({ page }) => {
    await loginUser(page);
    await page.goto('/app-store');

    await expect(page.getByRole('heading', { name: 'App Store' })).toBeVisible({ timeout: 30000 });
    await expect(page.getByPlaceholder('Search apps...').first()).toBeVisible({ timeout: 30000 });

    // Category buttons should be visible
    await expect(page.getByRole('button', { name: 'All' })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('button', { name: 'Featured' })).toBeVisible({ timeout: 30000 });
  });

  test('should filter by category', async ({ page }) => {
    await loginUser(page);
    await page.goto('/app-store');

    // Wait for the page to fully load before clicking
    const aiCategoryButton = page.getByRole('button', { name: 'Ai' });
    await expect(aiCategoryButton).toBeVisible({ timeout: 30000 });
    await aiCategoryButton.scrollIntoViewIfNeeded();
    await aiCategoryButton.click({ force: true });

    // The search should still be visible after category selection
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
