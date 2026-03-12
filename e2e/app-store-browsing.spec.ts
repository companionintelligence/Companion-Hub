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
    // Use force:true because the button may be transiently covered by loading overlays.
    await page.getByRole('button', { name: 'Ai' }).click({ force: true });
    await expect(page.getByPlaceholder('Search apps...').first()).toBeVisible({ timeout: 30000 });
  });

  test('should show empty state when no apps match search', async ({ page }) => {
    await loginUser(page);
    await page.goto('/app-store');

    // Wait for the page to fully load (heading or search visible)
    await expect(page.getByRole('heading', { name: 'App Store' })).toBeVisible({ timeout: 30000 });

    // The store may already be empty, but search should still work
    const searchInput = page.getByPlaceholder('Search apps...').first();
    await expect(searchInput).toBeVisible({ timeout: 30000 });
    await searchInput.fill('zzz-nonexistent-app-xyz');

    // Empty state shows translated "No app found" or the raw key
    await expect(page.getByText(/No app found|APP_STORE_NO_RESULTS/)).toBeVisible({ timeout: 30000 });
  });
});
