import { expect, loginUser, test } from '../fixtures/fixtures';
import { screenshots } from '../helpers/screenshot';

const UPDATE_BASELINES = process.env.UPDATE_VISUAL_BASELINES === '1';

test.describe('Visual regression', () => {
  test('login page layout', async ({ page }) => {
    const { createTestUser } = await import('../fixtures/fixtures');
    await createTestUser();
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    const name = 'login-page';

    if (UPDATE_BASELINES) {
      await screenshots.captureBaseline(page, name);
      return;
    }

    await screenshots.capture(page, name);
    const result = await screenshots.compare(name, { threshold: 0.02 });
    expect(result.mismatchedPixels).toBeGreaterThanOrEqual(0);
    expect(result.match, `Visual diff for ${name} — see e2e/screenshots/diff/${name}.png`).toBe(true);
  });

  test('dashboard layout (authenticated)', async ({ page }) => {
    await loginUser(page);
    await page.waitForLoadState('networkidle');

    const name = 'dashboard-authenticated';

    if (UPDATE_BASELINES) {
      await screenshots.captureBaseline(page, name);
      return;
    }

    await screenshots.capture(page, name);
    const result = await screenshots.compare(name, { threshold: 0.03 });
    expect(result.mismatchedPixels).toBeGreaterThanOrEqual(0);
    expect(result.match, `Visual diff for ${name} — see e2e/screenshots/diff/${name}.png`).toBe(true);
  });
});
