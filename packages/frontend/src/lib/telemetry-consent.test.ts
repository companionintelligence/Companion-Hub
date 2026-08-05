import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();

vi.mock('@/lib/api-fetch', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import {
  CONSENT_REFRESH_INTERVAL_MS,
  isTelemetryAllowed,
  refreshTelemetryConsent,
  refreshTelemetryConsentIfStale,
  resetTelemetryConsent,
  setTelemetryAllowed,
} from './telemetry-consent';

const jsonResponse = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

beforeEach(() => {
  apiFetch.mockReset();
  resetTelemetryConsent();
});

afterEach(() => {
  resetTelemetryConsent();
  vi.useRealTimers();
});

describe('isTelemetryAllowed', () => {
  it('is false before any answer has arrived', () => {
    // Unknown consent is not consent: beforeSend drops events until the Hub answers.
    expect(isTelemetryAllowed()).toBe(false);
  });
});

describe('refreshTelemetryConsent', () => {
  it('asks the unauthenticated Hub endpoint', async () => {
    apiFetch.mockResolvedValue(jsonResponse({ enabled: true, reason: null }));

    await expect(refreshTelemetryConsent()).resolves.toBe(true);
    expect(apiFetch).toHaveBeenCalledWith('/api/config/telemetry', { headers: { accept: 'application/json' } });
    expect(isTelemetryAllowed()).toBe(true);
  });

  it('refuses when the Hub says reporting is off', async () => {
    apiFetch.mockResolvedValue(jsonResponse({ enabled: false, reason: 'user-disabled' }));

    await expect(refreshTelemetryConsent()).resolves.toBe(false);
    expect(isTelemetryAllowed()).toBe(false);
  });

  it.each([
    ['a network failure', () => apiFetch.mockRejectedValue(new Error('offline'))],
    ['a non-2xx response', () => apiFetch.mockResolvedValue(jsonResponse({ enabled: true }, false))],
    ['an unparseable body', () => apiFetch.mockResolvedValue({ ok: true, json: async () => JSON.parse('{') } as unknown as Response)],
    ['a body without enabled', () => apiFetch.mockResolvedValue(jsonResponse({}))],
    ['a truthy-but-not-true enabled', () => apiFetch.mockResolvedValue(jsonResponse({ enabled: 'yes' }))],
  ])('fails closed on %s', async (_label, arrange) => {
    arrange();

    await expect(refreshTelemetryConsent()).resolves.toBe(false);
    expect(isTelemetryAllowed()).toBe(false);
  });

  it('takes effect mid-session in both directions, with no reload', async () => {
    apiFetch.mockResolvedValue(jsonResponse({ enabled: true, reason: null }));
    await refreshTelemetryConsent();
    expect(isTelemetryAllowed()).toBe(true);

    apiFetch.mockResolvedValue(jsonResponse({ enabled: false, reason: 'user-disabled' }));
    await refreshTelemetryConsent();
    expect(isTelemetryAllowed()).toBe(false);

    apiFetch.mockResolvedValue(jsonResponse({ enabled: true, reason: null }));
    await refreshTelemetryConsent();
    expect(isTelemetryAllowed()).toBe(true);
  });

  it('shares one request between concurrent callers', async () => {
    apiFetch.mockResolvedValue(jsonResponse({ enabled: true }));

    await Promise.all([refreshTelemetryConsent(), refreshTelemetryConsent(), refreshTelemetryConsent()]);

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});

describe('refreshTelemetryConsentIfStale', () => {
  it('does not re-ask inside the refresh interval', async () => {
    apiFetch.mockResolvedValue(jsonResponse({ enabled: true }));
    const now = 5_000_000;

    setTelemetryAllowed(true, now);
    refreshTelemetryConsentIfStale(now + CONSENT_REFRESH_INTERVAL_MS - 1);

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('re-asks once the answer is stale', async () => {
    apiFetch.mockResolvedValue(jsonResponse({ enabled: false }));
    const now = 6_000_000;

    setTelemetryAllowed(true, now);
    refreshTelemetryConsentIfStale(now + CONSENT_REFRESH_INTERVAL_MS);

    expect(apiFetch).toHaveBeenCalledTimes(1);
    // The refresh is fire-and-forget, so the new answer lands a tick later.
    await vi.waitFor(() => expect(isTelemetryAllowed()).toBe(false));
  });

  it('re-asks immediately while the answer is still unknown', async () => {
    apiFetch.mockResolvedValue(jsonResponse({ enabled: true }));

    refreshTelemetryConsentIfStale(7_000_000);

    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  });

  it('retries straight away after a failed read rather than waiting out the interval', async () => {
    // A failed read must not be recorded as a "no" answer, or a transient
    // startup failure would silence reporting for a whole interval.
    apiFetch.mockRejectedValue(new Error('offline'));
    await refreshTelemetryConsent();
    expect(isTelemetryAllowed()).toBe(false);

    apiFetch.mockResolvedValue(jsonResponse({ enabled: true }));
    refreshTelemetryConsentIfStale(8_000_000);

    expect(apiFetch).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(isTelemetryAllowed()).toBe(true));
  });
});
