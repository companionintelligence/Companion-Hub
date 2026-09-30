import { expect, loginUser, test } from '../fixtures/fixtures';
import { screenshots } from '../helpers/screenshot';

const UPDATE_BASELINES = process.env.UPDATE_VISUAL_BASELINES === '1';

/**
 * One comparison, so the two cases below cannot drift apart.
 *
 * Two things this deliberately does NOT do:
 *
 * - It does not assert `mismatchedPixels >= 0`. pixelmatch cannot return a negative count, so
 *   that assertion passed for any diff at all; the real check is `result.match`. It is the
 *   "assertion that can never fail" case in .claude/skills/test-audit/SKILL.md.
 * - It does not fail when a baseline is missing. `compare()` reports that as
 *   `mismatchedPixels: -1`, which the old assertion turned into a red test whose message
 *   pointed at a diff image that was never written. There is nothing to compare yet, so the
 *   test skips and says how to create one. Right now NO baselines are committed, so both
 *   cases skip — see docs/system/e2e.md.
 */
const compareAgainstBaseline = async (page: Parameters<typeof screenshots.capture>[0], name: string, threshold: number) => {
  if (UPDATE_BASELINES) {
    await screenshots.captureBaseline(page, name);
    return;
  }

  if (!screenshots.hasBaseline(name)) {
    test.skip(
      true,
      `No visual baseline for "${name}". Create one with: UPDATE_VISUAL_BASELINES=1 pnpm run test:visual, then commit e2e/screenshots/baselines/${name}.png`,
    );
    return;
  }

  await screenshots.capture(page, name);
  const result = await screenshots.compare(name, { threshold });

  expect(
    result.match,
    `Visual diff for ${name}: ${result.mismatchedPixels} pixels differ (threshold ${threshold}). See e2e/screenshots/diff/${name}.png`,
  ).toBe(true);
};

/**
 * NOT `networkidle`. The dashboard polls its stat tiles, so the network is never idle there and
 * `waitForLoadState('networkidle')` burned the whole 60s test timeout without capturing anything.
 * Wait for the content that has to be on screen instead — which is also what a baseline wants: a
 * deterministic settle rather than a network heuristic.
 */
const settle = async (page: Parameters<typeof screenshots.capture>[0], marker: string | null) => {
  await page.waitForLoadState('domcontentloaded');
  if (marker) {
    await expect(page.getByText(marker).first()).toBeVisible({ timeout: 30000 });
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000);
};

test.describe('Visual regression', () => {
  test('login page layout', async ({ page }) => {
    const { createTestUser } = await import('../fixtures/fixtures');
    await createTestUser();
    await page.goto('/login');
    await settle(page, null);

    await compareAgainstBaseline(page, 'login-page', 0.02);
  });

  test('dashboard layout (authenticated)', async ({ page }) => {
    await loginUser(page);
    await settle(page, 'Disk space');

    await compareAgainstBaseline(page, 'dashboard-authenticated', 0.03);
  });
});
