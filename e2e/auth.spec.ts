import { testUser } from './helpers/constants';
import { expect, test, createTestUser } from './fixtures/fixtures';

test('should register a new user', async ({ page }) => {
  await page.goto('/register');

  await page.getByPlaceholder('you@example.com').fill(testUser.email);
  await page.getByPlaceholder('Enter your password').fill(testUser.password);
  await page.getByPlaceholder('Confirm your password').fill(testUser.password);

  await page.getByRole('button', { name: 'Register' }).click();

  // Welcome screen
  await expect(page.getByRole('heading', { name: 'Thanks for using Companion Hub' })).toBeVisible();
  await page.getByRole('button', { name: 'Save and enter' }).click();

  await expect(page.getByText('Disk space')).toBeVisible();
});

test('should login with existing user', async ({ page }) => {
  await createTestUser();

  await page.goto('/login');

  await page.getByPlaceholder('you@example.com').fill(testUser.email);
  await page.getByPlaceholder('Enter your password').fill(testUser.password);
  await page.getByRole('button', { name: 'Login' }).click();

  await expect(page.getByText('Disk space')).toBeVisible();
});
