import fs from 'node:fs';
import path from 'node:path';
import { type BrowserContext, type Page, expect, test as base } from '@playwright/test';
import { user } from '../../packages/backend/src/core/database/drizzle/schema';
import { testUser } from '../helpers/constants';
import { clearDatabase, db, seedOrganization } from '../helpers/db';

const BACKEND_URL = `http://localhost:${process.env.BACKEND_PORT || '3000'}`;
const DATA_DIR = process.env.CI_HUB_DATA_DIR || '/tmp/ci-hub-e2e';
const TUNNEL_DIR = process.env.CI_HUB_TUNNEL_DIR || path.join(DATA_DIR, 'tunnel');
const TUNNEL_TOKEN_PATH = path.join(TUNNEL_DIR, 'token');

/** Recreate the tunnel token so isRegistered() returns true even after freshUnregistered() tests. */
function ensureTunnelToken() {
  if (!fs.existsSync(TUNNEL_DIR)) fs.mkdirSync(TUNNEL_DIR, { recursive: true });
  fs.writeFileSync(TUNNEL_TOKEN_PATH, 'e2e-mock-tunnel-token', 'utf-8');
}

async function resetBackendState() {
  try {
    await fetch(`${BACKEND_URL}/api/registration/reset`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  } catch {
    // Non-fatal — backend may already be unregistered or unreachable
  }
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await resetBackendState(); // clear backend memory before DB wipe
    await clearDatabase();
    await seedOrganization();
    ensureTunnelToken(); // restore token after freshUnregistered() may have deleted it
    await resetBackendState(); // sync backend with the new DB + token state
    await use(page);
  },
});

// biome-ignore lint/performance/noBarrelFile: Re-exporting for convenience
export { expect } from '@playwright/test';

export const createTestUser = async () => {
  await db.insert(user).values({ password: testUser.hashedPassword, username: testUser.email, operator: true, hasCompletedOnboarding: true });
};

async function submitLogin(page: Page) {
  const email = page.getByPlaceholder('you@example.com');
  await email.waitFor();
  // The login page writes the operator address into this field when the portal
  // hint returns. Filling while that write is in flight doubles the address
  // (`test@test.comtest@test.com`), and the browser then blocks the submit.
  await page.waitForResponse((response) => response.url().includes('/api/auth/portal/session-hint'), { timeout: 15_000 }).catch(() => undefined);
  await expect(async () => {
    if ((await email.inputValue()) !== testUser.email) {
      await email.fill(testUser.email);
    }
    expect(await email.inputValue()).toBe(testUser.email);
  }).toPass();
  await page.getByPlaceholder('Enter your password').fill(testUser.password);
  const login = page.getByRole('button', { name: 'Login', exact: true });
  await expect(login).toBeEnabled();
  await login.click();
  await page.waitForURL(/\/home/, { timeout: 30_000 });
}

export const loginUser = async (page: Page, _?: BrowserContext) => {
  // Create user in database
  await createTestUser();

  await page.goto('/login');
  await submitLogin(page);

  const disk = page.getByText('Disk space');
  try {
    await expect(disk).toBeVisible({ timeout: 20_000 });
  } catch {
    // The first authenticated navigation can miss a Vite chunk. The app reloads
    // once for that, and the reload can land back on the login form. Check the
    // URL after the navigation settles, then sign in again if the session did not stick.
    await page.goto('/home');
    if (page.url().includes('/login')) {
      await submitLogin(page);
    }
    await expect(disk).toBeVisible({ timeout: 30_000 });
  }
};
