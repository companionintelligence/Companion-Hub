/**
 * Routes that only render once an app is installed and running.
 *
 * The default Playwright lane skips this file. Set E2E_WITH_DOCKER=true to
 * start the nginx:alpine fixture from installedApp().
 */

import { expect, test, type Page } from '@playwright/test';
import { loginUser } from './fixtures/fixtures';
import { E2E_WITH_DOCKER, INSTALLED_APP, installedApp, stopInstalledApp } from './fixtures/scenarios';

const storeApp = `/store/${INSTALLED_APP.storeSlug}/${INSTALLED_APP.name}`;
const installedStoreApp = `/apps/${INSTALLED_APP.storeSlug}/${INSTALLED_APP.name}`;
const customApp = `/apps/${INSTALLED_APP.name}`;

async function openAsOperator(page: Page) {
  await loginUser(page);
  const reloaded = await page.request.patch(`/api/marketplace/${INSTALLED_APP.storeSlug}`, {
    data: { name: INSTALLED_APP.storeName, enabled: true },
  });
  expect(reloaded.ok(), await reloaded.text()).toBeTruthy();
}

test.describe('installed app routes', () => {
  test.skip(!E2E_WITH_DOCKER, 'Set E2E_WITH_DOCKER=true to start the nginx fixture');
  test.describe.configure({ timeout: 180_000 });

  test.beforeEach(async () => {
    await installedApp();
  });

  test.afterAll(async () => {
    await stopInstalledApp();
  });

  test('store app details shows the access URL of the running container', async ({ page }) => {
    await openAsOperator(page);
    await page.goto(storeApp);
    await expect(page).toHaveURL(new RegExp(`${storeApp}$`));
    await expect(page.getByRole('heading', { name: 'Access points' })).toBeVisible();
    await expect(page.getByText(`:${INSTALLED_APP.hostPort}`).first()).toBeVisible();
  });

  test('installed store app details shows the same access URL', async ({ page }) => {
    await openAsOperator(page);
    await page.goto(installedStoreApp);
    await expect(page).toHaveURL(new RegExp(`${installedStoreApp}$`));
    await expect(page.getByRole('heading', { name: 'Access points' })).toBeVisible();
    await expect(page.getByText(`:${INSTALLED_APP.hostPort}`).first()).toBeVisible();
  });

  test('store update shows the compose diff', async ({ page }) => {
    await openAsOperator(page);
    await page.goto(`${storeApp}/update`);
    await expect(page).toHaveURL(new RegExp(`${storeApp}/update$`));
    await expect(page.getByTestId('app-update')).toBeVisible();
    await expect(page.getByText('Compose file changed')).toBeVisible();
  });

  test('installed store update shows the config diff', async ({ page }) => {
    await openAsOperator(page);
    await page.goto(`${installedStoreApp}/update`);
    await expect(page).toHaveURL(new RegExp(`${installedStoreApp}/update$`));
    await expect(page.getByTestId('app-update')).toBeVisible();
    await expect(page.getByText('Configuration changed')).toBeVisible();
  });

  test('custom app details offers Open while the app is running', async ({ page }) => {
    await openAsOperator(page);
    await page.goto(customApp);
    await expect(page).toHaveURL(new RegExp(`${customApp}$`));
    await expect(page.getByRole('button', { name: 'Open' })).toBeVisible();
  });

  test('custom app edit shows the nginx compose', async ({ page }) => {
    await openAsOperator(page);
    await page.goto(`${customApp}/edit`);
    await expect(page).toHaveURL(new RegExp(`${customApp}/edit$`));
    await expect(page.getByDisplayValue(INSTALLED_APP.image)).toBeVisible();
  });
});
