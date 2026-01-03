import { expect, loginUser, test } from './fixtures/fixtures';

test('should navigate to settings', async ({ page, context }) => {
  await loginUser(page, context);
  
  await page.getByTestId('settings-button').click();
  await expect(page.getByRole('tablist')).toBeVisible();
});

test('should see security settings', async ({ page, context }) => {
  await loginUser(page, context);
  await page.goto('/settings');
  
  await page.getByRole('tab', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { name: 'Change username' })).toBeVisible();
});
