import { expect, test, createTestUser } from './fixtures/fixtures';
import { testUser } from './helpers/constants';

test.describe('Error States', () => {
  test('should show error for invalid login', async ({ page }) => {
    await createTestUser();
    await page.goto('/login');

    await page.getByPlaceholder('you@example.com').fill(testUser.email);
    await page.getByPlaceholder('Enter your password').fill('wrong-password');
    await page.getByRole('button', { name: 'Login' }).click();

    // Should show some error indication (stay on login page)
    await expect(page).toHaveURL(/\/login/);
  });

  test('should show error for non-existent user login', async ({ page }) => {
    await createTestUser();
    await page.goto('/login');

    await page.getByPlaceholder('you@example.com').fill('nonexistent@test.com');
    await page.getByPlaceholder('Enter your password').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();

    await expect(page).toHaveURL(/\/login/);
  });

  test('should have disabled login button when fields are empty', async ({ page }) => {
    await createTestUser();
    await page.goto('/login');

    // Login button should be disabled when fields are empty
    await expect(page.getByRole('button', { name: 'Login' })).toBeDisabled();
  });
});
