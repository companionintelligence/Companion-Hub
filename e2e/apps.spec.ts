import { expect, loginUser, test } from './fixtures/fixtures';

test('should navigate to app store', async ({ page }) => {
  await loginUser(page);

  await page.getByRole('link', { name: 'Store' }).click();
  await page.waitForURL(/\/store/);
  // The store has no "App Store" heading — the landing view is the featured layout, whose only
  // headings are section names ("Featured", "Trending", …). Asserting a heading named "App Store"
  // passed only until that view landed, and then failed for the life of the lane.
  //
  // Anchor on chrome that does not depend on seeded data: the sync button and the search box
  // always render, while `store-label` / `store-switcher` need a populated app-stores list, which
  // the default lane does not seed.
  await expect(page.getByRole('button', { name: 'Check for Updates' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByPlaceholder('Search apps...').first()).toBeVisible();
});

test('should search for an app', async ({ page }) => {
  await loginUser(page);
  await page.goto('/store');

  const searchBox = page.getByPlaceholder('Search apps...').first();
  await searchBox.fill('test-app');
  await expect(searchBox).toHaveValue('test-app');
});
