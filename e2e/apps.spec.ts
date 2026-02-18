import { expect, loginUser, test } from './fixtures/fixtures';

test('should navigate to app store', async ({ page }) => {
  await loginUser(page);

  await page.getByRole('link', { name: 'App Store' }).click();
  await expect(page.getByRole('heading', { name: 'App Store' })).toBeVisible();
  await expect(page.getByPlaceholder('Search apps...').first()).toBeVisible();
});

test('should search for an app', async ({ page }) => {
  await loginUser(page);
  await page.goto('/app-store');

  const searchBox = page.getByPlaceholder('Search apps...').first();
  await searchBox.fill('test-app');
  await expect(searchBox).toHaveValue('test-app');
});
