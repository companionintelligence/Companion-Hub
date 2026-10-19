import { expect, test } from './fixtures/fixtures';
import { testUser } from './helpers/constants';
import { clearDatabase, seedOrganization } from './helpers/db';

test.describe('First-Time User Experience', () => {
  test.beforeEach(async () => {
    await clearDatabase();
    await seedOrganization();
  });

  // A paired Hub with no admin opens on sign-in, with the CI Account button (#2061).
  test('should show sign-in on first access', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
    await expect(page.getByRole('heading', { name: /Login to your local admin account/i })).toBeVisible();
    await expect(page.getByText('Sign in using your CI Account')).toBeVisible();
  });

  test('should open onboarding after the first sign-in', async ({ page }) => {
    await page.goto('/login');

    await page.getByPlaceholder('you@example.com').fill(testUser.email);
    await page.getByPlaceholder('Enter your password').fill(testUser.password);
    await page.getByRole('button', { name: 'Login' }).click();

    // The first admin goes on to the onboarding wizard
    await expect(page.getByRole('heading', { name: 'Set Up Companion Hub' })).toBeVisible({ timeout: 15000 });
  });
});
