import { expect, loginUser, test } from './fixtures/fixtures';
import { db } from './helpers/db';
import { appStore } from '../packages/backend/src/core/database/drizzle/schema';

test.describe('Dev Mode App Store Flow', () => {
  test('should install an app from CI-Cloud dev server', async ({ page, context }) => {
    // 0. Setup: Add CI-Cloud store to DB
    // We use onConflictDoUpdate to ensure it's there and updated if needed
    await db
      .insert(appStore)
      .values({
        slug: 'ci-cloud-local',
        hash: 'local-dev-hash',
        name: 'CI Cloud Local',
        url: 'http://localhost:8001', // CI-Cloud dev server port
        branch: 'main',
        type: 'ci_cloud_api',
      })
      .onConflictDoUpdate({
        target: appStore.slug,
        set: {
          url: 'http://localhost:8001',
          type: 'ci_cloud_api',
        },
      });

    // 1. Login
    await loginUser(page, context);

    // 2. Go to App Store
    await page.goto('/app-store');

    // 3. Search for 'whoami'
    // This assumes CI-Cloud dev server is running and serving 'whoami' app metadata
    await page.getByPlaceholder('Search').fill('whoami');

    // 4. Install
    await expect(page.getByText('Whoami')).toBeVisible({ timeout: 15000 });
    await page.getByText('Whoami').click();

    await page.getByRole('button', { name: 'Install' }).click();

    // Handle potential confirmation modal if it exists
    // (Based on general runtipi/CI-OS-Hub behavior, there is usually a config/confirm step)
    const installBtn = page.getByRole('button', { name: 'Install' });
    if ((await installBtn.count()) > 0 && (await installBtn.isVisible())) {
      await installBtn.click();
    }

    // 5. Verify installation success
    // Takes time to pull and start container
    await expect(page.getByRole('button', { name: 'Open' })).toBeVisible({ timeout: 120000 });

    // 6. Verify basic functionality
    await page.getByRole('button', { name: 'Open' }).click();
    // This usually opens a new tab. Playwright handles popups but we verify context.
    // For now transparency that it is installed is good.

    await page.goto('/dashboard');
    await expect(page.getByText('Whoami')).toBeVisible();
  });
});
