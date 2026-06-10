import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { init, setTag } = vi.hoisted(() => ({
  init: vi.fn(),
  setTag: vi.fn(),
}));

vi.mock('@sentry/nestjs', () => ({
  init,
  setTag,
}));

vi.mock('./core/error-reporting/sentry-scrubber', () => ({
  scrubEvent: vi.fn(),
}));

describe('backend sentry instrumentation', () => {
  const originalEnv = {
    DEVICE_ID: process.env.DEVICE_ID,
    SENTRY_DSN: process.env.SENTRY_DSN,
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.SENTRY_DSN = 'https://backend@example.ingest.sentry.io/123456';
  });

  afterEach(() => {
    if (originalEnv.DEVICE_ID === undefined) {
      delete process.env.DEVICE_ID;
    } else {
      process.env.DEVICE_ID = originalEnv.DEVICE_ID;
    }

    if (originalEnv.SENTRY_DSN === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalEnv.SENTRY_DSN;
    }
  });

  it('tags the backend Sentry scope with the device id when available', async () => {
    process.env.DEVICE_ID = 'device-123';

    await import('./instrument');

    expect(init).toHaveBeenCalledTimes(1);
    expect(setTag).toHaveBeenCalledWith('device_id', 'device-123');
  });

  it('does not tag the backend scope when no device id is configured', async () => {
    delete process.env.DEVICE_ID;

    await import('./instrument');

    expect(init).toHaveBeenCalledTimes(1);
    expect(setTag).not.toHaveBeenCalled();
  });
});
