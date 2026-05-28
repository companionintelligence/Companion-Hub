/**
 * Shared verification helpers for launch-path testing.
 *
 * These are reusable assertion helpers that later DAG issues can
 * import to verify Hub state without duplicating setup/assertion logic.
 */

import type { Page, APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import * as schema from '../../packages/backend/src/core/database/drizzle/schema';
import { db } from './db';

const BACKEND_URL = `http://localhost:${process.env.BACKEND_PORT || '3000'}`;

// ---------------------------------------------------------------------------
// Health verification
// ---------------------------------------------------------------------------

/** Verify the backend health endpoint returns ok. */
export async function verifyBackendHealth(request: APIRequestContext) {
  const response = await request.get(`${BACKEND_URL}/api/health`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.status).toBe('ok');
  return body;
}

/** Verify the data health endpoint reports sane directory structure. */
export async function verifyDataHealth(request: APIRequestContext) {
  const response = await request.get(`${BACKEND_URL}/api/health/data`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body).toHaveProperty('ok');
  expect(body).toHaveProperty('dirs');
  return body;
}

// ---------------------------------------------------------------------------
// Registration status verification
// ---------------------------------------------------------------------------

/** Verify the registration status endpoint returns expected registered state. */
export async function verifyRegistrationStatus(request: APIRequestContext, expectedRegistered: boolean) {
  const response = await request.get(`${BACKEND_URL}/api/registration/status`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.registered).toBe(expectedRegistered);
  return body;
}

/** Verify the device-id endpoint returns a non-empty device ID. */
export async function verifyDeviceId(request: APIRequestContext) {
  const response = await request.get(`${BACKEND_URL}/api/registration/device-id`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.device_id).toBeTruthy();
  return body;
}

// ---------------------------------------------------------------------------
// Page-level verification
// ---------------------------------------------------------------------------

/** Verify the page redirects to device registration for an unregistered Hub. */
export async function verifyDeviceRegistrationGate(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/device-registration/, { timeout: 15000 });
  await expect(page.getByRole('heading', { name: /Device Registration Required/i })).toBeVisible({ timeout: 15000 });
}

/** Verify the first-user registration screen is shown for a registered Hub with no users. */
export async function verifyFirstUserRegistrationPage(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/register/, { timeout: 15000 });
  await expect(page.getByRole('heading', { name: /Create local admin user for this device/i })).toBeVisible({ timeout: 15000 });
}

/** Verify the page shows the login screen for a registered Hub with no session. */
export async function verifyLoginScreen(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/login/, { timeout: 15000 });
  await expect(page.getByRole('heading', { name: /Login to your local admin account/i })).toBeVisible({ timeout: 15000 });
}

/** Verify the dashboard loads after login. */
export async function verifyDashboard(page: Page) {
  await expect(page.getByText('Disk space')).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('CPU load')).toBeVisible({ timeout: 30000 });
}

// ---------------------------------------------------------------------------
// App store verification
// ---------------------------------------------------------------------------

/** Verify the app store page loads and shows expected UI. */
export async function verifyAppStorePage(page: Page) {
  await page.goto('/app-store');
  await expect(page.getByRole('heading', { name: 'App Store' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByPlaceholder('Search apps...').first()).toBeVisible({ timeout: 30000 });
}

/** Verify the settings page shows app store sources. */
export async function verifyAppStoreSettings(page: Page) {
  await page.goto('/settings');
  await expect(page.getByRole('tablist')).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('tab', { name: 'App Stores' })).toBeVisible({ timeout: 30000 });
}

/** Verify the settings page renders the expected app store names. */
export async function verifyAppStoreNames(page: Page, expectedNames: string[]) {
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.waitForURL(/\/settings/, { timeout: 30000 });
  await expect(page.getByRole('tab', { name: 'App Stores' })).toBeVisible({ timeout: 30000 });
  await page.getByRole('tab', { name: 'App Stores' }).click();
  for (const name of expectedNames) {
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible({ timeout: 30000 });
  }
}

/** Verify a seeded installed app exists in the database with the expected status. */
export async function verifyInstalledAppState(appName: string, expectedStatus: string) {
  const apps = await db.select().from(schema.app);
  const app = apps.find((entry) => entry.appName === appName);
  expect(app).toBeTruthy();
  expect(app?.status).toBe(expectedStatus);
}

/** Verify the app-store table contains the expected slugs. */
export async function verifySeededAppStores(expectedSlugs: string[]) {
  const stores = await db.select().from(schema.appStore);
  const slugs = stores.map((store) => store.slug).sort();
  expect(slugs).toEqual([...expectedSlugs].sort());
}
