import { expect, loginUser, test } from './fixtures/fixtures';
import { multiStore } from './fixtures/scenarios';

test.describe('Multi-Store Context', () => {
  test.beforeEach(async () => {
    await multiStore();
  });

  test('loads the app store inside explicit query-param store context', async ({ page }) => {
    await loginUser(page);

    await page.goto('/store?store=ci-apps');
    // No "App Store" heading exists — the landing view is the featured layout. Same anchor as
    // apps.spec.ts: the sync button always renders, whatever the seeded catalog holds.
    await expect(page.getByRole('button', { name: 'Check for Updates' })).toBeVisible({ timeout: 30000 });
    // The param has to SURVIVE the page's own URL writes, not just be what we navigated to.
    // app-store-page.tsx used to drop `store` on mount (see docs/system/e2e.md, known red).
    await expect(page).toHaveURL(/\/store\?store=ci-apps/, { timeout: 30000 });
    await expect(page.getByPlaceholder('Search apps...').first()).toBeVisible({ timeout: 30000 });
  });

  test('redirects store-specific path routing into explicit query-param context', async ({ page }) => {
    await loginUser(page);

    await page.goto('/store/community-apps');
    await expect(page.getByRole('button', { name: 'Check for Updates' })).toBeVisible({ timeout: 30000 });
    await expect(page).toHaveURL(/\/store\?store=community-apps/, { timeout: 30000 });
  });
});
