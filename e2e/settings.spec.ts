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
  await page.goto('/settings');

  await expect(page.getByRole('tab', { name: 'Security' })).toBeVisible({ timeout: 30000 });
  await page.getByRole('tab', { name: 'Security' }).click({ force: true });
  await expect(page.getByRole('heading', { name: 'Change username' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible({ timeout: 30000 });
});
