/**
 * E2E Platform Test Helpers
 *
 * Shared utilities for platform test specs.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, type APIRequestContext } from '@playwright/test';

const execAsync = promisify(exec);

export const APP_ID = 'ci-e2e-test-app';
export const APP_STORE = 'ci-marketplace';
export const APP_URN = `${APP_ID}:${APP_STORE}`;
export const APP_PORT = 7100;
export const BASE_URL = process.env.HUB_URL || 'http://localhost:5002';
export const APP_URL = process.env.APP_URL || `http://localhost:${APP_PORT}`;

export const FORM_DEFAULTS = {
  E2E_TEXT_FIELD: 'hello-e2e',
  E2E_PASSWORD: 'secret123',
  E2E_EMAIL: 'e2e@test.com',
  E2E_NUMBER: '42',
  E2E_URL: 'https://example.com',
  E2E_BOOLEAN: 'true',
};

/**
 * Login to the Hub API (required before install/uninstall)
 */
export async function login(request: APIRequestContext) {
  const username = process.env.HUB_USERNAME || 'admin@core1hub.local';
  const password = process.env.HUB_PASSWORD || 'CIComputer2026!';
  const res = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { username, password },
  });
  expect(res.ok(), `Login failed: ${res.status()}`).toBeTruthy();
}

/**
 * Install the test app via Hub API
 */
export async function installApp(request: APIRequestContext) {
  const res = await request.post(`${BASE_URL}/api/app-lifecycle/${APP_URN}/install`, {
    data: {
      E2E_TEXT_FIELD: FORM_DEFAULTS.E2E_TEXT_FIELD,
      E2E_PASSWORD: FORM_DEFAULTS.E2E_PASSWORD,
      E2E_EMAIL: FORM_DEFAULTS.E2E_EMAIL,
      E2E_NUMBER: FORM_DEFAULTS.E2E_NUMBER,
      E2E_URL: FORM_DEFAULTS.E2E_URL,
      E2E_BOOLEAN: FORM_DEFAULTS.E2E_BOOLEAN,
    },
  });
  expect(res.ok(), `Install failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

/**
 * Uninstall the test app via Hub API
 */
export async function uninstallApp(request: APIRequestContext, options?: { deleteAllData?: boolean }) {
  const res = await request.delete(`${BASE_URL}/api/app-lifecycle/${APP_URN}/uninstall`, {
    data: {
      deleteAllData: options?.deleteAllData ?? true,
    },
  });
  expect(res.ok(), `Uninstall failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

/**
 * Get app status from Hub API
 */
export async function getAppStatus(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${BASE_URL}/api/apps/${APP_URN}`);
  if (!res.ok()) return 'not_found';
  const data = await res.json();
  return data.status || data.app?.status || 'unknown';
}

/**
 * Wait for all app containers to reach running state
 */
export async function waitForRunning(timeoutMs = 120_000) {
  const start = Date.now();
  const expected = ['ci-e2e-test-app', 'ci-e2e-test-app-db', 'ci-e2e-test-app-cache', 'ci-e2e-test-app-worker', 'ci-e2e-test-app-udp'];

  while (Date.now() - start < timeoutMs) {
    try {
      const { stdout } = await execAsync(`docker ps --filter "name=ci-e2e-test-app" --filter "status=running" --format "{{.Names}}"`);
      const running = stdout.trim().split('\n').filter(Boolean);
      if (expected.every((name) => running.some((r) => r.includes(name)))) {
        return running;
      }
    } catch {
      /* ignored */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Timeout waiting for containers after ${timeoutMs}ms`);
}

/**
 * Count running containers for the test app
 */
export async function countContainers(): Promise<number> {
  const { stdout } = await execAsync(`docker ps --filter "name=ci-e2e-test-app" --filter "status=running" --format "{{.Names}}"`);
  return stdout.trim().split('\n').filter(Boolean).length;
}

/**
 * Build test app Docker images
 */
export async function buildImages() {
  const base = 'e2e/platform-test-app/services';
  await execAsync(`docker build -t ci-e2e-test-app-web:latest ${base}/web`);
  await execAsync(`docker build -t ci-e2e-test-app-worker:latest ${base}/worker`);
  await execAsync(`docker build -t ci-e2e-test-app-udp:latest ${base}/udp-echo`);
}

/**
 * Force remove all test app containers
 */
export async function cleanupContainers() {
  try {
    const { stdout } = await execAsync(`docker ps -a --filter "name=ci-e2e-test-app" --format "{{.Names}}"`);
    const names = stdout.trim().split('\n').filter(Boolean);
    if (names.length > 0) {
      await execAsync(`docker rm -f ${names.join(' ')}`);
    }
  } catch {
    /* ignored */
  }
}
