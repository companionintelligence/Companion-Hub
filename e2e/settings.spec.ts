import { expect, loginUser, test } from './fixtures/fixtures';

test('should navigate to settings', async ({ page }) => {
  await loginUser(page);

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('tablist')).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('tab', { name: 'Security' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('tab', { name: 'App Stores' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('tab', { name: 'Logs' })).toBeVisible({ timeout: 30000 });
});

test('should see security settings', async ({ page }) => {
  await loginUser(page);

  // Use client-side navigation instead of page.goto() to avoid full page reload
  // which can stall in CI due to re-initialization of auth, i18n, and app context
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.waitForURL(/\/settings/, { timeout: 30000 });

  // Wait for settings page to fully stabilize (Suspense boundaries settle)
  await expect(page.getByRole('tablist')).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible({ timeout: 30000 });

  // Use a retry loop for the click — React re-renders can detach the element between locate and click
  await expect(async () => {
    await page.getByRole('tab', { name: 'Security' }).click();
    await expect(page.getByRole('tab', { name: 'Security' })).toHaveAttribute('aria-selected', 'true');
  }).toPass({ timeout: 30000 });

  await expect(page.getByRole('heading', { name: 'Change username' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible({ timeout: 30000 });
});
