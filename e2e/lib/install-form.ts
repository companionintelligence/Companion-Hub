/**
 * install-form.ts
 *
 * Handles the ci-hub app store install flow:
 *   1. Reads the app's config.json from ci-marketplace
 *   2. Classifies each field: auto-fill silently vs. show to user
 *   3. Fills the install form in the hub UI
 *   4. Selects "Public Web" exposure (default in hub)
 *   5. Submits and waits for the app to reach running state
 *
 * Field classification rules:
 *   - `random`               → generate + fill, never shown to user
 *   - `required` + no default → generate best-effort value, SHOWN to user
 *   - weak default (changeme) → override with better value, SHOWN to user
 *   - sensible default        → use as-is, silent
 *   - user-meaningful fields  → any field whose label/env implies user choice
 *     (admin email, username, domain, etc.) → SHOWN to user
 */

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { AppConfig, FormField, FieldResolution } from './config';
import { resolveAllFields } from './config';
import type { Reporter } from './reporter';

const USER_MEANINGFUL_PATTERNS = [
  /admin.?email/i, /admin.?user/i, /username/i,
  /domain/i, /host(?!name)/i, /smtp/i, /s3.?bucket/i,
  /api.?key/i, /oauth/i, /ldap/i, /saml/i,
];

function isUserMeaningful(field: FormField): boolean {
  const haystack = field.label + ' ' + field.env_variable;
  return USER_MEANINGFUL_PATTERNS.some(p => p.test(haystack));
}

/**
 * Resolve fields, but elevate user-meaningful ones to showToUser=true
 * regardless of whether they have a default.
 */
function resolveFields(fields: FormField[]): FieldResolution[] {
  return resolveAllFields(fields).map(r => {
    if (!r.showToUser && isUserMeaningful(r.field)) {
      return { ...r, showToUser: true, reason: 'User-configurable setting — review before production use' };
    }
    return r;
  });
}

// ─── Hub form interaction ─────────────────────────────────────────────────────

/** Fill a single form field in the hub install modal. */
async function fillField(page: Page, field: FormField, value: string): Promise<boolean> {
  // Hub renders fields by env_variable name or label as data attributes / aria labels
  const selectors = [
    `[data-env="${field.env_variable}"]`,
    `[name="${field.env_variable}"]`,
    `[id="${field.env_variable}"]`,
    `input[aria-label="${field.label}"]`,
    `label:has-text("${field.label}") + input`,
    `label:has-text("${field.label}") ~ input`,
    // Some hubs render form label text then input inside the same div
    `:text("${field.label}") >> xpath=following::input[1]`,
  ];

  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        if (field.type === 'boolean') {
          const checked = value === 'true';
          const current = await el.isChecked().catch(() => false);
          if (current !== checked) await el.click();
        } else {
          await el.clear();
          await el.fill(value);
        }
        return true;
      }
    } catch {}
  }
  return false;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export interface InstallResult {
  status: 'pass' | 'fail' | 'timeout';
  appUrl?: string;
  filledFields: FieldResolution[];
  unfillableFields: FormField[];
  notes: string[];
}

export async function installApp(
  page: Page,
  appName: string,
  config: AppConfig,
  reporter: Reporter,
  opts: { hubUrl: string; installTimeoutMs?: number }
): Promise<InstallResult> {
  const { hubUrl, installTimeoutMs = 180_000 } = opts;
  const notes: string[] = [];
  const filledFields: FieldResolution[] = [];
  const unfillableFields: FormField[] = [];

  // ── Navigate to app store and search ──
  await page.goto(`${hubUrl}/app-store`);
  await expect(page.getByRole('heading', { name: /app store/i })).toBeVisible({ timeout: 20_000 });

  const searchBox = page.getByPlaceholder('Search apps...').first();
  await searchBox.fill(appName);
  await page.waitForTimeout(800);

  await reporter.screenshot(page, '01-store-search');

  // Click the app card
  const appCard = page.getByText(appName, { exact: false }).first();
  await expect(appCard).toBeVisible({ timeout: 10_000 });
  await appCard.click();
  await page.waitForTimeout(1000);

  await reporter.screenshot(page, '02-app-detail');

  // ── Click Install ──
  const installBtn = page.getByRole('button', { name: /^install$/i }).first();
  await expect(installBtn).toBeVisible({ timeout: 10_000 });
  await installBtn.click();
  await page.waitForTimeout(800);

  await reporter.screenshot(page, '03-install-modal');

  // ── Fill install form ──
  const fields = config.form_fields ?? [];
  const resolutions = resolveFields(fields);

  // Register user-visible fields with reporter immediately so they appear even if install fails
  reporter.addUserVisibleConfig(resolutions);

  for (const resolution of resolutions) {
    if (resolution.field.type === 'random') {
      // Hub generates these itself for random fields — we don't fill them
      // but we may still need to if the hub doesn't pre-fill
      const filled = await fillField(page, resolution.field, resolution.value);
      if (filled) filledFields.push(resolution);
      continue;
    }

    if (!resolution.value && !resolution.field.required) {
      // Skip optional empty fields
      continue;
    }

    const filled = await fillField(page, resolution.field, resolution.value);
    if (filled) {
      filledFields.push(resolution);
      notes.push(`Filled: ${resolution.field.label} = ${
        ['password','random'].includes(resolution.field.type) ? '***' : resolution.value
      }`);
    } else if (resolution.field.required) {
      unfillableFields.push(resolution.field);
      notes.push(`Could not fill required field: ${resolution.field.label}`);
    }
  }

  // ── Select "Public Web" exposure (default, but be explicit) ──
  try {
    const exposureSelect = page.locator('select[name*="exposure"], [data-testid*="exposure"]').first();
    if (await exposureSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await exposureSelect.selectOption({ label: /public web/i } as any);
      notes.push('Selected: Public Web exposure');
    } else {
      // Try radio/button pattern
      const publicWebOption = page.getByLabel(/public web/i).first();
      if (await publicWebOption.isVisible({ timeout: 1500 }).catch(() => false)) {
        await publicWebOption.click();
        notes.push('Selected: Public Web exposure (radio)');
      }
    }
  } catch {}

  await reporter.screenshot(page, '04-install-form-filled');

  // ── Submit ──
  const submitBtn = page.getByRole('button', { name: /install|confirm|deploy|start/i }).last();
  if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await submitBtn.click();
    notes.push('Submitted install form');
  }

  await reporter.screenshot(page, '05-installing');

  // ── Wait for running state ──
  const runningIndicator = page.getByText(/running|installed|ready|active/i);
  const started = await runningIndicator.waitFor({ timeout: installTimeoutMs, state: 'visible' })
    .then(() => true)
    .catch(() => false);

  if (!started) {
    await reporter.screenshot(page, '05-install-timeout');
    return { status: 'timeout', filledFields, unfillableFields, notes };
  }

  await reporter.screenshot(page, '06-installed');

  // ── Extract app URL ──
  let appUrl: string | undefined;
  try {
    const appSection = page.locator(`text=${appName}`).locator('..').locator('..');
    const openLink   = appSection.getByRole('link', { name: /open|launch|visit/i }).first();
    appUrl = await openLink.getAttribute('href') ?? undefined;
  } catch {}

  if (!appUrl && config.exposable) {
    const appId = config.id.toLowerCase().replace(/\s+/g, '-');
    appUrl = `https://${appId}.${process.env.APP_DOMAIN ?? 'ci.computer'}`;
  }

  notes.push(`App URL: ${appUrl ?? 'unknown'}`);
  return { status: 'pass', appUrl, filledFields, unfillableFields, notes };
}
