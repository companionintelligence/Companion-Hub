/**
 * Platform E2E: Form Fields
 *
 * Verifies all form field types are correctly injected as env vars.
 */

import { test, expect } from '@playwright/test';
import { APP_URL, FORM_DEFAULTS } from './helpers';

test.describe('Form Fields', () => {
  let envVars: Record<string, string>;

  test.beforeAll(async ({ request }) => {
    const res = await request.get(`${APP_URL}/api/env`);
    expect(res.ok()).toBeTruthy();
    envVars = await res.json();
  });

  test('E2E_TEXT_FIELD injected correctly', () => {
    expect(envVars.E2E_TEXT_FIELD).toBe(FORM_DEFAULTS.E2E_TEXT_FIELD);
  });

  test('E2E_PASSWORD injected correctly', () => {
    expect(envVars.E2E_PASSWORD).toBe(FORM_DEFAULTS.E2E_PASSWORD);
  });

  test('E2E_EMAIL injected correctly', () => {
    expect(envVars.E2E_EMAIL).toBe(FORM_DEFAULTS.E2E_EMAIL);
  });

  test('E2E_NUMBER injected correctly', () => {
    expect(String(envVars.E2E_NUMBER)).toBe(FORM_DEFAULTS.E2E_NUMBER);
  });

  test('E2E_URL injected correctly', () => {
    expect(envVars.E2E_URL).toBe(FORM_DEFAULTS.E2E_URL);
  });

  test('E2E_BOOLEAN injected correctly', () => {
    expect(String(envVars.E2E_BOOLEAN)).toBe(FORM_DEFAULTS.E2E_BOOLEAN);
  });

  test('E2E_RANDOM_HEX exists and is 64 hex chars', () => {
    expect(envVars.E2E_RANDOM_HEX).toBeDefined();
    expect(envVars.E2E_RANDOM_HEX).toMatch(/^[0-9a-f]{64}$/i);
  });

  test('E2E_RANDOM_B64 exists and is valid base64', () => {
    expect(envVars.E2E_RANDOM_B64).toBeDefined();
    expect(() => Buffer.from(envVars.E2E_RANDOM_B64, 'base64')).not.toThrow();
    expect(Buffer.from(envVars.E2E_RANDOM_B64, 'base64').length).toBeGreaterThanOrEqual(24);
  });
});
