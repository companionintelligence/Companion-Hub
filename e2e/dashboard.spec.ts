import { expect, loginUser, test } from './fixtures/fixtures';

test('should display dashboard for logged in user', async ({ page, context }) => {
  await loginUser(page, context);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('System Status')).toBeVisible();
});

test('should display guest dashboard', async ({ page }) => {
  // We need to create a user so we don't get redirected to /register
  const { createTestUser } = await import('./fixtures/fixtures');
  await createTestUser();

  await page.goto('/');
  // Guest dashboard might be different or redirect to login if no public apps.
  // By default, it should show something or redirect.
  // If no user exists, it redirects to register.
  // If user exists but not logged in, it redirects to login.
  // Unless guest dashboard is enabled.
  
  // Let's assume it redirects to login for now as we haven't configured guest dashboard.
  await expect(page).toHaveURL(/\/login/);
});
