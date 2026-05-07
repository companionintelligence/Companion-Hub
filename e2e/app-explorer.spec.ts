/**
 * app-explorer.spec.ts — Orchestrator
 *
 * Thin test file. All logic lives in e2e/lib/*.
 *
 * Steps:
 *   1. Find app in hub store
 *   2. Fill install form (reads ci-marketplace config.json for field defaults)
 *   3. Wait for DNS / container boot (up to DNS_TIMEOUT_MINUTES, timer starts here)
 *   4. Create account / log in on the running app
 *   5. AI-guided exploration for EXPLORE_MINUTES
 *   6. Write report + optional fix-request
 *
 * Environment:
 *   APP_NAME              App to install (required)
 *   HUB_URL               ci-hub frontend (default: http://localhost:9091)
 *   TEST_EMAIL            Hub login email
 *   TEST_PASSWORD         Hub login password
 *   APP_TEST_EMAIL        Email for account creation on the app (default: explorer@ci.computer)
 *   APP_TEST_PASSWORD     Password for account on the app     (default: Explorer123!)
 *   APP_TEST_NAME         Display name for account            (default: CI Explorer)
 *   APP_DOMAIN            Base domain for app subdomains      (default: ci.computer)
 *   EXPLORE_MINUTES       Exploration duration after load     (default: 5)
 *   DNS_TIMEOUT_MINUTES   Max wait for app URL to resolve     (default: 10)
 *   MARKETPLACE_DIR       Path to ci-marketplace repo root
 *   OPENAI_API_KEY        Enables AI-guided exploration
 *   REPORT_DIR            Report output directory
 *   SCREENSHOT_DIR        Screenshot output directory
 *
 * DNS note:
 *   Self-hosted apps receive a subdomain after install. DNS propagation + container
 *   boot can take several minutes. The exploration timer only starts once the URL
 *   returns a non-5xx response. After DNS_TIMEOUT_MINUTES, the test fails with
 *   verdict "dns-timeout" and a fix-request is written for the agent.
 */

import type { Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import * as path from 'node:path';

import { loadAppConfig, resolveAppId } from './lib/config';
import { Reporter } from './lib/reporter';
import { installApp } from './lib/install-form';
import { attemptAppAuth } from './lib/app-auth';
import { exploreApp } from './lib/ai-explorer';

// ─── Config ───────────────────────────────────────────────────────────────────

const APP_NAME = process.env.APP_NAME ?? '';
const HUB_URL = process.env.HUB_URL ?? 'http://localhost:9091';
const TEST_EMAIL = process.env.TEST_EMAIL ?? 'test@ci.computer';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'testpassword123';
const APP_DOMAIN = process.env.APP_DOMAIN ?? 'ci.computer';

const EXPLORE_MS = Number.parseInt(process.env.EXPLORE_MINUTES ?? '5', 10) * 60_000;
const DNS_TIMEOUT_MS = Number.parseInt(process.env.DNS_TIMEOUT_MINUTES ?? '10', 10) * 60_000;
const DNS_POLL_MS = 10_000;

const REPORT_DIR = process.env.REPORT_DIR ?? path.join(__dirname, '../reports');
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR ?? path.join(__dirname, '../screenshots');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loginHub(page: Page) {
  await page.goto(`${HUB_URL}/login`);
  await page.getByPlaceholder(/email/i).fill(TEST_EMAIL);
  await page.getByPlaceholder(/password/i).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page.getByText(/dashboard|my apps/i)).toBeVisible({ timeout: 15_000 });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

test.describe(`App Explorer: ${APP_NAME || 'unset'}`, () => {
  test.skip(!APP_NAME, 'APP_NAME env var is required to run app explorer tests');

  const appId = resolveAppId(APP_NAME) ?? APP_NAME.toLowerCase().replace(/\s+/g, '-');
  const config = loadAppConfig(appId);
  const reporter = new Reporter(APP_NAME, appId, { screenshotDir: SCREENSHOT_DIR, reportDir: REPORT_DIR });

  if (config?.version) reporter.report.version = config.version;

  // ── 1 · Install ─────────────────────────────────────────────────────────────
  test('1. Install app from hub store', async ({ page }) => {
    await loginHub(page);

    if (!config) {
      reporter.issue(`No config.json found in marketplace for appId: ${appId} — install form will be best-effort`);
    }

    const result = await installApp(page, APP_NAME, config ?? { id: appId, name: APP_NAME }, reporter, {
      hubUrl: HUB_URL,
      installTimeoutMs: 180_000,
    });

    reporter.step('install', {
      status: result.status === 'pass' ? 'pass' : 'fail',
      filledFieldCount: result.filledFields.length,
      unfillableFields: result.unfillableFields.map((f) => f.env_variable),
      appUrl: result.appUrl,
      notes: result.notes,
    });

    if (result.status === 'timeout') {
      reporter.issue('App did not reach running state within 3 min — possible container boot failure or bad config');
    }

    if (result.unfillableFields.length) {
      reporter.issue(`Could not fill required fields: ${result.unfillableFields.map((f) => f.label).join(', ')}`);
    }
  });

  // ── 2 · DNS wait + load ──────────────────────────────────────────────────────
  test('2. Wait for app to become reachable', async ({ page }) => {
    const appUrl = (reporter.report.steps.install as { appUrl?: string })?.appUrl ?? `https://${appId}.${APP_DOMAIN}`;
    reporter.step('dns', { status: 'running', appUrl });

    const deadline = Date.now() + DNS_TIMEOUT_MS;
    let reachable = false;
    let attempts = 0;
    let lastError = '';

    while (Date.now() < deadline) {
      attempts++;
      try {
        const res = await page.goto(appUrl, { timeout: 15_000, waitUntil: 'domcontentloaded' });
        const status = res?.status() ?? 0;
        if (status > 0 && status < 500) {
          reachable = true;
          break;
        }
        lastError = `HTTP ${status}`;
      } catch (e: unknown) {
        lastError = (e as Error).message?.split('\n')[0] ?? String(e);
      }
      await page.waitForTimeout(DNS_POLL_MS);
    }

    if (!reachable) {
      reporter.step('dns', {
        status: 'fail',
        reason: 'dns-timeout',
        appUrl,
        attempts,
        waitedMin: DNS_TIMEOUT_MS / 60_000,
        lastError,
        note:
          `App URL did not become reachable within ${DNS_TIMEOUT_MS / 60_000} minutes. ` +
          'DNS propagation may still be in progress, or the container failed to start. ' +
          'Check container health and image availability.',
      });
      reporter.report.verdict = 'dns-timeout';
      reporter.issue(`DNS/boot timeout after ${DNS_TIMEOUT_MS / 60_000} min (${attempts} attempts): ${appUrl} — last error: ${lastError}`);
      await reporter.screenshot(page, 'dns-timeout');
      test.fail(); // marks test explicitly failed
      return;
    }

    reporter.step('dns', { status: 'pass', appUrl, attempts, resolvedAfterMs: attempts * DNS_POLL_MS });
    await reporter.screenshot(page, 'app-loaded');
  });

  // ── 3 · Auth ─────────────────────────────────────────────────────────────────
  test('3. Create account / log in', async ({ page }) => {
    const appUrl = (reporter.report.steps.install as { appUrl?: string })?.appUrl ?? `https://${appId}.${APP_DOMAIN}`;

    await page.goto(appUrl, { timeout: 20_000, waitUntil: 'domcontentloaded' });

    const auth = await attemptAppAuth(page);

    reporter.step('auth', {
      status: auth.success ? 'pass' : 'warn',
      method: auth.method,
      notes: auth.notes,
    });

    if (!auth.success) {
      reporter.issue(`Auth failed (method: ${auth.method}): ${auth.notes.join('; ')}`);
    }

    await reporter.screenshot(page, `auth-${auth.method}`);
  });

  // ── 4 · Explore ──────────────────────────────────────────────────────────────
  test('4. Explore app', async ({ context }) => {
    const appUrl = (reporter.report.steps.install as { appUrl?: string })?.appUrl ?? `https://${appId}.${APP_DOMAIN}`;
    const authMethod = (reporter.report.steps.auth as { method?: string })?.method ?? 'unknown';

    const appPage = await context.newPage();
    await appPage.goto(appUrl, { timeout: 20_000, waitUntil: 'domcontentloaded' });

    const result = await exploreApp(appPage, authMethod, EXPLORE_MS, (label) => reporter.screenshot(appPage, label));

    reporter.report.session = result.session;
    reporter.step('explore', {
      status: result.errorsCount > result.actionsCount / 2 ? 'warn' : 'pass',
      actionsCount: result.actionsCount,
      observationsCount: result.observationsCount,
      errorsCount: result.errorsCount,
      durationMs: result.durationMs,
      errors: result.errors.slice(0, 10),
    });

    await reporter.screenshot(appPage, 'explore-end');
    await appPage.close();
  });

  // ── Finalise ─────────────────────────────────────────────────────────────────
  test.afterAll(async () => {
    reporter.finalise();
    const reportPath = reporter.write();
    reporter.writeFixRequest(reportPath);
  });
});
