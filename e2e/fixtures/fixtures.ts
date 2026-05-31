import { type BrowserContext, type Page, expect, test as base } from '@playwright/test';
import { user } from '../../packages/backend/src/core/database/drizzle/schema';
import { testUser } from '../helpers/constants';
import { clearDatabase, db, seedOrganization } from '../helpers/db';

const BACKEND_URL = `http://localhost:${process.env.BACKEND_PORT || '3000'}`;

async function resetBackendState() {
  try {
    await fetch(`${BACKEND_URL}/api/registration/reset`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  } catch {
    // Non-fatal — backend may already be unregistered or unreachable
  }
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await resetBackendState();
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

  await page.waitForURL(/\/home/, { timeout: 30000 });
  await expect(page.getByText('Disk space')).toBeVisible({ timeout: 30000 });
};
