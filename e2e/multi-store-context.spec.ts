import { expect, loginUser, test } from './fixtures/fixtures';
import { multiStore } from './fixtures/scenarios';

test.describe('Multi-Store Context', () => {
  test.beforeEach(async () => {
    await multiStore();
  });

  test('loads the app store inside explicit query-param store context', async ({ page }) => {
    await loginUser(page);

    await page.goto('/app-store?store=ci-apps');
    await expect(page.getByRole('heading', { name: 'App Store' })).toBeVisible({ timeout: 30000 });
    await expect(page).toHaveURL(/\/app-store\?store=ci-apps/, { timeout: 30000 });
    await expect(page.getByPlaceholder('Search apps...').first()).toBeVisible({ timeout: 30000 });
  });

  test('redirects store-specific path routing into explicit query-param context', async ({ page }) => {
    await loginUser(page);

    await page.goto('/app-store/community-apps');
    await expect(page.getByRole('heading', { name: 'App Store' })).toBeVisible({ timeout: 30000 });
    await expect(page).toHaveURL(/\/app-store\?store=community-apps/, { timeout: 30000 });
  });
});
