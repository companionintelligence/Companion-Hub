/**
 * Launch-path verification smoke tests.
 *
 * These cover the reusable hub states and scenario fixtures introduced for
 * DAG issue #387. The goal is deterministic, maintained foundation coverage
 * for later registration, lifecycle, desktop, and multi-store work.
 */

import { expect, test } from '@playwright/test';
import { createTestUser, loginUser } from './fixtures/fixtures';
import { freshUnregistered, locallyReady, publiclyDelayed, degradedHub } from './fixtures/hub-states';
import { firstInstallPath, appLifecycleReconciliation, multiStore } from './fixtures/scenarios';
import { testUser } from './helpers/constants';
import {
  verifyAppStoreNames,
  verifyAppStorePage,
  verifyBackendHealth,
  verifyDashboard,
  verifyDataHealth,
  verifyDeviceId,
  verifyDeviceRegistrationGate,
  verifyFirstUserRegistrationPage,
  verifyInstalledAppState,
  verifyLoginScreen,
  verifyRegistrationStatus,
  verifySeededAppStores,
} from './helpers/verification';

const firstUserPassword = 'SecurePass123!';

test.describe('Hub State: Fresh Unregistered', () => {
  test.beforeEach(async () => {
    await freshUnregistered();
  });

  test('health endpoint is available even when unregistered', async ({ request }) => {
    await verifyBackendHealth(request);
  });

  test('registration status reports unregistered', async ({ request }) => {
    await verifyRegistrationStatus(request, false);
  });

  test('device-id endpoint returns a device identifier', async ({ request }) => {
    await verifyDeviceId(request);
  });

  test('UI gates access behind device registration', async ({ page }) => {
    await verifyDeviceRegistrationGate(page);
  });
});

test.describe('Hub State: Locally Ready', () => {
  test.beforeEach(async () => {
    await locallyReady();
  });

  test('health endpoint is healthy', async ({ request }) => {
    await verifyBackendHealth(request);
  });

  test('data health reports sane directories', async ({ request }) => {
    await verifyDataHealth(request);
  });

  test('registration status reports registered', async ({ request }) => {
    await verifyRegistrationStatus(request, true);
  });

  test('login screen is shown when the Hub is registered but no session exists', async ({ page }) => {
    await createTestUser();
    await verifyLoginScreen(page);
  });

  test('dashboard loads after login', async ({ page }) => {
    await loginUser(page);
    await verifyDashboard(page);
  });

  test('app store page loads after login', async ({ page }) => {
    await loginUser(page);
    await verifyAppStorePage(page);
  });
});

test.describe('Hub State: Publicly Delayed', () => {
  test.beforeEach(async () => {
    await publiclyDelayed();
  });

  test('health endpoint is still healthy', async ({ request }) => {
    await verifyBackendHealth(request);
  });

  test('registration status still reports locally registered', async ({ request }) => {
    await verifyRegistrationStatus(request, true);
  });

  test('login remains available even while the public route is delayed', async ({ page }) => {
    await createTestUser();
    await verifyLoginScreen(page);
  });

  test('direct navigation to device registration does not force re-pair while the public route is delayed', async ({ page }) => {
    await createTestUser();
    await page.goto('/device-registration');
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
    await expect(page.getByRole('heading', { name: /Login to your local admin account/i })).toBeVisible({ timeout: 15000 });
  });
});

test.describe('Hub State: Degraded', () => {
  test.beforeEach(async () => {
    await degradedHub();
  });

  test('health endpoint is available even when portal APIs are degraded', async ({ request }) => {
    await verifyBackendHealth(request);
  });

  test('registration status stays locally registered', async ({ request }) => {
    await verifyRegistrationStatus(request, true);
  });

  test('existing login path still renders', async ({ page }) => {
    await createTestUser();
    await verifyLoginScreen(page);
  });
});

test.describe('Scenario: First Install Path', () => {
  test.beforeEach(async () => {
    await firstInstallPath();
  });

  test('first visit shows the account registration page', async ({ page }) => {
    await verifyFirstUserRegistrationPage(page);
  });

  test('can complete first-user registration', async ({ page }) => {
    await page.goto('/register');
    await page.getByPlaceholder('you@example.com').fill(testUser.email);
    await page.getByPlaceholder('Enter your password').fill(firstUserPassword);
    await page.getByPlaceholder('Confirm your password').fill(firstUserPassword);
    await page.getByRole('button', { name: 'Create Local Admin User' }).click();

    await expect(page.getByRole('heading', { name: 'Set Up Companion Hub' })).toBeVisible({ timeout: 15000 });
  });
});

test.describe('Scenario: App Lifecycle Reconciliation', () => {
  test.beforeEach(async () => {
    await appLifecycleReconciliation();
  });

  test('API health is ok with a stuck app in the database', async ({ request }) => {
    await verifyBackendHealth(request);
  });

  test('shared verification helper finds the stuck app state', async () => {
    await verifyInstalledAppState('test-stuck-app', 'installing');
  });

  test('dashboard still loads after login while reconciliation data exists', async ({ page }) => {
    await loginUser(page);
    await verifyDashboard(page);
  });
});

test.describe('Scenario: Multi-Store', () => {
  test.beforeEach(async () => {
    await multiStore();
  });

  test('shared verification helper confirms both app stores are seeded', async () => {
    await verifySeededAppStores(['ci-apps', 'community-apps']);
  });

  test('settings renders both configured app stores', async ({ page }) => {
    await loginUser(page);
    await verifyAppStoreNames(page, ['CI Apps', 'Community']);
  });
});
