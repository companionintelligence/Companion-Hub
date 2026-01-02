import { expect, loginUser, test } from './fixtures/fixtures';

test('should navigate to settings', async ({ page, context }) => {
  await loginUser(page, context);
  
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});

test('should update user profile', async ({ page, context }) => {
  await loginUser(page, context);
  await page.goto('/settings');
  
  await page.getByPlaceholder('First Name').fill('Jane');
  await page.getByRole('button', { name: 'Save' }).click();
  
  // Verify toast or value
  await expect(page.getByPlaceholder('First Name')).toHaveValue('Jane');
});
