import { testUser } from './helpers/constants';
import { expect, test, createTestUser } from './fixtures/fixtures';

// The fixtures pair the Hub, and a paired Hub's first admin signs in with a CI Account in its
// organization. Signing up made an account in none, which the next check-in revoked (#2061).
test('makes the first CI Account to sign in the admin', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/, { timeout: 15000 });

  await page.getByPlaceholder('you@example.com').fill(testUser.email);
  await page.getByPlaceholder('Enter your password').fill(testUser.password);
  await page.getByRole('button', { name: 'Login' }).click();

  // The first admin goes on to the onboarding wizard
  await expect(page.getByRole('heading', { name: 'Set Up Companion Hub' })).toBeVisible({ timeout: 15000 });
});

test('sends /register on a paired Hub to sign-in', async ({ page }) => {
  await page.goto('/register');
  await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
});

test('should login with existing user', async ({ page }) => {
  await createTestUser();

  await page.goto('/login');

  await page.getByPlaceholder('you@example.com').fill(testUser.email);
  await page.getByPlaceholder('Enter your password').fill(testUser.password);
  await page.getByRole('button', { name: 'Login' }).click();

  await expect(page.getByText('Disk space')).toBeVisible({ timeout: 30000 });
});
