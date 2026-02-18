import { expect, test } from './fixtures/fixtures';
import { clearDatabase, seedOrganization } from './helpers/db';

test.describe('First-Time User Experience', () => {
  test.beforeEach(async () => {
    await clearDatabase();
    await seedOrganization();
  });

  test('should show register page on first access', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/register/);
    await expect(page.getByRole('heading', { name: 'Register your account' })).toBeVisible();
  });

  test('should complete registration and see welcome screen', async ({ page }) => {
    await page.goto('/register');

    await page.getByPlaceholder('you@example.com').fill('admin@test.local');
    await page.getByPlaceholder('Enter your password').fill('SecurePass123!');
    await page.getByPlaceholder('Confirm your password').fill('SecurePass123!');
    await page.getByRole('button', { name: 'Register' }).click();

    // Welcome screen
    await expect(page.getByRole('heading', { name: 'Thanks for using Companion Hub' })).toBeVisible();
  });

  test('should reach dashboard after completing welcome wizard', async ({ page }) => {
    await page.goto('/register');

    await page.getByPlaceholder('you@example.com').fill('admin@test.local');
    await page.getByPlaceholder('Enter your password').fill('SecurePass123!');
    await page.getByPlaceholder('Confirm your password').fill('SecurePass123!');
    await page.getByRole('button', { name: 'Register' }).click();

    await expect(page.getByRole('heading', { name: 'Thanks for using Companion Hub' })).toBeVisible();
    await page.getByRole('button', { name: 'Save and enter' }).click();

    await expect(page.getByText('Disk space')).toBeVisible();
    await expect(page.getByText('CPU load')).toBeVisible();
  });
});
