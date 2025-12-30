import { expect, test } from '@playwright/test';
import { user } from '../packages/backend/src/core/database/drizzle/schema';
import { testUser } from './helpers/constants';
import { db, clearDatabase } from './helpers/db';

test.beforeEach(async ({ page, context }) => {
  await clearDatabase();
  
  // Create user in database
  await db.insert(user).values({ password: testUser.hashedPassword, username: testUser.email, operator: true, hasSeenWelcome: true });

  await page.goto('/login');
  await page.getByPlaceholder('you@example.com').fill(testUser.email);
  await page.getByPlaceholder('Your password').fill(testUser.password);
  await page.getByRole('button', { name: 'Login' }).click();

  // Wait for dashboard to load
  await expect(page.getByText('Disk space')).toBeVisible({ timeout: 10000 });
});

test('app store page is scrollable', async ({ page }) => {
  // Mock a large list of apps to ensure scrolling is necessary
  await page.route('**/api/marketplace/apps/search**', async (route) => {
    const apps = Array.from({ length: 50 }).map((_, i) => ({
      id: `app-${i}`,
      storeId: 'default',
      name: `App ${i}`,
      short_desc: `Description for App ${i}`,
      categories: ['Utilities'],
      urn: `default:app-${i}`,
      icon: 'https://example.com/icon.png',
      versions: [],
    }));
    
    await route.fulfill({
      json: {
        data: apps,
        nextCursor: null,
      },
    });
  });

  await page.goto('/app-store');
  
  const scrollContainer = page.getByTestId('app-store-scroll-container');
  await expect(scrollContainer).toBeVisible();

  // Wait for at least one app to be visible
  await expect(page.getByRole('heading', { name: 'App 0' })).toBeVisible();

  // Check initial scroll position
  const initialScrollTop = await scrollContainer.evaluate((el) => el.scrollTop);
  expect(initialScrollTop).toBe(0);

  // Scroll down
  await scrollContainer.evaluate((el) => el.scrollTo(0, 100));
  
  // Check new scroll position
  const newScrollTop = await scrollContainer.evaluate((el) => el.scrollTop);
  expect(newScrollTop).toBe(100);
});

test('settings page is scrollable', async ({ page }) => {
  await page.goto('/settings');
  
  // Force a small viewport height to ensure scrolling is needed
  await page.setViewportSize({ width: 1280, height: 400 });

  const scrollContainer = page.getByTestId('settings-scroll-container');
  await expect(scrollContainer).toBeVisible();

  // Inject content to ensure overflow
  await scrollContainer.evaluate((el) => {
    const div = document.createElement('div');
    div.style.height = '2000px';
    div.textContent = 'Forced Scroll Content';
    el.appendChild(div);
  });

  // Check initial scroll position
  const initialScrollTop = await scrollContainer.evaluate((el) => el.scrollTop);
  expect(initialScrollTop).toBe(0);

  // Scroll down
  await scrollContainer.evaluate((el) => el.scrollTo(0, 100));
  
  const newScrollTop = await scrollContainer.evaluate((el) => el.scrollTop);
  expect(newScrollTop).toBe(100);
});
