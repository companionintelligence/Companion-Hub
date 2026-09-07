import { expect, test } from './fixtures/fixtures';
import { testUser } from './helpers/constants';
import { clearDatabase, seedOrganization } from './helpers/db';

const firstUserPassword = 'SecurePass123!';

test.describe('First-Time User Experience', () => {
  test.beforeEach(async () => {
    await clearDatabase();
    await seedOrganization();
  });

  test('should show register page on first access', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/register/);
    await expect(page.getByRole('heading', { name: 'Create local admin user for this device' })).toBeVisible();
  });

  test('should redirect to onboarding after registration', async ({ page }) => {
    await page.goto('/register');

    await page.getByPlaceholder('you@example.com').fill(testUser.email);
    await page.getByPlaceholder('Enter your password').fill(firstUserPassword);
    await page.getByPlaceholder('Confirm your password').fill(firstUserPassword);
    await page.getByRole('button', { name: 'Create Local Admin User' }).click();

    // New users go to onboarding wizard
    await expect(page.getByRole('heading', { name: 'Set Up Companion Hub' })).toBeVisible({ timeout: 15000 });
  });
});
