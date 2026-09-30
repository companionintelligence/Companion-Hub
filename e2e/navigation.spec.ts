import { expect, loginUser, test } from './fixtures/fixtures';

test.describe('Navigation', () => {
  test('should navigate to all main pages', async ({ page }) => {
    await loginUser(page);

    // Dashboard (already there after login) — data loads asynchronously
    await expect(page.getByText('Disk space')).toBeVisible({ timeout: 30000 });

    // The centre links live in the header's <nav>. Scope to it: the brand mark on the left is
    // ALSO a link named "Home" (aria-label, since 80cf93aa0 made it icon-only), and an unscoped
    // getByRole('link', { name: 'Home' }) resolves to both — a strict-mode violation, not a click.
    const nav = page.getByRole('navigation');

    // App Store
    await nav.getByRole('link', { name: 'Store' }).click();
    await page.waitForURL(/\/store/);
    await expect(page.getByPlaceholder('Search apps...').first()).toBeVisible({ timeout: 30000 });

    // Settings — wait for page to stabilize after navigation (React re-renders)
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForURL(/\/settings/);
    await expect(async () => {
      await expect(page.getByRole('tablist')).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible();
    }).toPass({ timeout: 30000 });

    // Back to Dashboard
    await nav.getByRole('link', { name: 'Home' }).click();
    await page.waitForURL(/\/home/);
    await expect(page.getByText('Disk space')).toBeVisible({ timeout: 30000 });
  });

  test('should have working logo link to dashboard', async ({ page }) => {
    await loginUser(page);

    // Use client-side navigation instead of page.goto() to avoid full page reload
    // which can stall in CI due to re-initialization of auth, i18n, and app context
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForURL(/\/settings/, { timeout: 30000 });
    await expect(async () => {
      await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible();
    }).toPass({ timeout: 30000 });

    // The brand mark is the link that wraps the logo image. Its accessible name is "Home"
    // (aria-label), which the centre nav's Home link shares — so pick it by what it contains,
    // not by name. "Companion Intelligence Logo" has not been its name since 80cf93aa0.
    await page
      .getByRole('link', { name: 'Home' })
      .filter({ has: page.getByRole('img', { name: 'CI Logo Icon' }) })
      .click();
    await expect(page).toHaveURL(/\/home/);
    await expect(page.getByText('Disk space')).toBeVisible({ timeout: 30000 });
  });

  test('should logout', async ({ page }) => {
    await loginUser(page);

    await page.getByRole('button', { name: 'Logout' }).first().click();
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  });
});
