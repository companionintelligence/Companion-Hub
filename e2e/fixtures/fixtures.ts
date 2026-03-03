import { type BrowserContext, type Page, expect, test as base } from '@playwright/test';
import { user } from '../../packages/backend/src/core/database/drizzle/schema';
import { testUser } from '../helpers/constants';
import { clearDatabase, db, seedOrganization } from '../helpers/db';

export const test = base.extend({
  page: async ({ page }, use) => {
    await clearDatabase();
    await seedOrganization();
    await use(page);
  },
});

// biome-ignore lint/performance/noBarrelFile: Re-exporting for convenience
export { expect } from '@playwright/test';

export const createTestUser = async () => {
  await db.insert(user).values({ password: testUser.hashedPassword, username: testUser.email, operator: true, hasCompletedOnboarding: true });
};

export const loginUser = async (page: Page, _?: BrowserContext) => {
  // Create user in database
  await createTestUser();

  // Login flow
  await page.goto('/login');

  await page.getByPlaceholder('you@example.com').fill(testUser.email);
  await page.getByPlaceholder('Enter your password').fill(testUser.password);
  await page.getByRole('button', { name: 'Login' }).click();

  await expect(page.getByText('Disk space')).toBeVisible({ timeout: 15000 });
};
