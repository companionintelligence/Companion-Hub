import { expect, loginUser, test } from './fixtures/fixtures';

test('should display dashboard for logged in user', async ({ page }) => {
  await loginUser(page);
  await expect(page.getByText('Disk space')).toBeVisible();
  await expect(page.getByText('CPU load')).toBeVisible();
  await expect(page.getByText('Memory used')).toBeVisible();
});

test('should display login page for unauthenticated user', async ({ page }) => {
  // Seed a user, so this is the login page of a Hub that already has an admin
  const { createTestUser } = await import('./fixtures/fixtures');
  await createTestUser();

  await page.goto('/');
  // Should redirect to login
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Login to your local admin account' })).toBeVisible();
});
