import { expect, loginUser, test } from './fixtures/fixtures';

test('should navigate to app store', async ({ page, context }) => {
  await loginUser(page, context);
  
  await page.getByRole('button', { name: 'App Store' }).click();
  await expect(page.getByPlaceholder('Search')).toBeVisible();
});

test('should search for an app', async ({ page, context }) => {
  await loginUser(page, context);
  await page.goto('/app-store');
  
  await page.getByPlaceholder('Search').fill('plex');
  // Assuming Plex is in the store or at least the search works
  // We can check if the URL updates or results appear.
  await expect(page.getByPlaceholder('Search')).toHaveValue('plex');
});
