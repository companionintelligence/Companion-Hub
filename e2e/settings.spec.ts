import { expect, loginUser, test } from './fixtures/fixtures';

test('should navigate to settings', async ({ page }) => {
  await loginUser(page);

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('tablist')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Security' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'App Stores' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Logs' })).toBeVisible();
});

test('should see security settings', async ({ page }) => {
  await loginUser(page);
  await page.goto('/settings');

  await page.getByRole('tab', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { name: 'Change username' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
});
