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

export { expect } from '@playwright/test';

export const createTestUser = async () => {
  // Create user in database
  await db.insert(user).values({ password: testUser.hashedPassword, username: testUser.email, operator: true, hasSeenWelcome: true });
};

export const loginUser = async (page: Page, _: BrowserContext) => {
  await page.addLocatorHandler(page.getByText('Insecure configuration'), async () => {
    await page.getByRole('button', { name: 'Close' }).click();
  });

  // Create user in database
  await createTestUser();

  // Login flow
  await page.goto('/login');

  await page.getByPlaceholder('you@example.com').fill(testUser.email);
  await page.getByPlaceholder('Enter your password').fill(testUser.password);
  await page.getByRole('button', { name: 'Login' }).click();

  await expect(page.getByText('Disk space')).toBeVisible();
};

type InstallAppOpts = {
  visibleOnGuestDashboard?: boolean;
  domain?: string;
};

export const installApp = async (page: Page, storeSlug: string, appId: string, opts: InstallAppOpts = {}) => {
  await page.goto(`/app-store/${storeSlug}/${appId}`);

  // Install app
  await page.getByRole('button', { name: 'Install' }).click();

  await expect(page.getByText('Expose app on local network')).toBeVisible();

  if (opts.visibleOnGuestDashboard) {
    await page.getByLabel('isVisibleOnGuestDashboard').setChecked(true);
  }

  if (opts.domain) {
    await page.getByLabel('exposed', { exact: true }).setChecked(true);
    await page.getByRole('textbox', { name: 'domain' }).fill(opts.domain);
  }

  await page.getByRole('button', { name: 'Install' }).click();

  await expect(page.getByText('Installing')).toBeVisible();
  await expect(page.getByText('Running')).toBeVisible({ timeout: 60000 });
};
