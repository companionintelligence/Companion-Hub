/**
 * Platform E2E: Web UI
 *
 * Verifies the test app serves HTML, CSS, images, and SPA fallback.
 */

import { test, expect } from '@playwright/test';
import { APP_URL } from './helpers';

test.describe('Web UI', () => {
  test('page title contains "CI E2E Test App"', async ({ page }) => {
    await page.goto(APP_URL);
    await expect(page).toHaveTitle(/CI E2E Test App/);
  });

  test('CSS stylesheet loaded (computed styles)', async ({ page }) => {
    await page.goto(APP_URL);
    const bgColor = await page.evaluate(() => {
      return getComputedStyle(document.body).backgroundColor;
    });
    // #f8f9fa = rgb(248, 249, 250)
    expect(bgColor).toContain('248');
  });

  test('static image loaded', async ({ page }) => {
    await page.goto(APP_URL);
    const imgLoaded = await page.evaluate(() => {
      const img = document.getElementById('logo') as HTMLImageElement;
      return img && img.complete && img.naturalWidth > 0;
    });
    expect(imgLoaded).toBe(true);
  });

  test('SPA fallback — /subpage returns index.html', async ({ page }) => {
    await page.goto(`${APP_URL}/subpage/test`);
    await expect(page).toHaveTitle(/CI E2E Test App/);
    await expect(page.locator('h1')).toContainText('CI E2E Test App');
  });
});
