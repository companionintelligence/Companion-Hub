import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { init, setTag, setUser } = vi.hoisted(() => ({
  init: vi.fn(),
  setTag: vi.fn(),
  setUser: vi.fn(),
}));

vi.mock('@sentry/nestjs', () => ({
  init,
  setTag,
  setUser,
}));

vi.mock('./core/error-reporting/sentry-scrubber', () => ({
  scrubEvent: vi.fn(),
}));

describe('backend sentry instrumentation', () => {
  const originalEnv = {
    CI_CLOUD_URL: process.env.CI_CLOUD_URL,
    CI_HUB_VERSION: process.env.CI_HUB_VERSION,
    CI_HUB_IMAGE: process.env.CI_HUB_IMAGE,
    DEVICE_ID: process.env.DEVICE_ID,
    SENTRY_DSN: process.env.SENTRY_DSN,
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.SENTRY_DSN = 'https://backend@example.ingest.sentry.io/123456';
    process.env.CI_CLOUD_URL = 'https://hub.ci.computer/';
    process.env.CI_HUB_VERSION = 'v0.2.27';
    process.env.CI_HUB_IMAGE = 'ghcr.io/companionintelligence/ci-hub:v0.2.27';
  });

  afterEach(() => {
    if (originalEnv.DEVICE_ID === undefined) {
      delete process.env.DEVICE_ID;
    } else {
      process.env.DEVICE_ID = originalEnv.DEVICE_ID;
    }

    if (originalEnv.CI_CLOUD_URL === undefined) {
      delete process.env.CI_CLOUD_URL;
    } else {
      process.env.CI_CLOUD_URL = originalEnv.CI_CLOUD_URL;
    }

    if (originalEnv.CI_HUB_VERSION === undefined) {
      delete process.env.CI_HUB_VERSION;
    } else {
      process.env.CI_HUB_VERSION = originalEnv.CI_HUB_VERSION;
    }

    if (originalEnv.CI_HUB_IMAGE === undefined) {
      delete process.env.CI_HUB_IMAGE;
    } else {
      process.env.CI_HUB_IMAGE = originalEnv.CI_HUB_IMAGE;
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
    expect(setUser).toHaveBeenCalledWith({ id: 'device-123' });
    expect(setTag).toHaveBeenCalledWith('ci_portal_url', 'https://hub.ci.computer');
    expect(setTag).toHaveBeenCalledWith('ci_portal_environment', 'prod');
    expect(setTag).toHaveBeenCalledWith('deployment_version', 'v0.2.27');
    expect(setTag).toHaveBeenCalledWith('hub_image', 'ghcr.io/companionintelligence/ci-hub:v0.2.27');
    expect(setTag).toHaveBeenCalledWith('hub_image_tag', 'v0.2.27');
  });

  it('does not tag the backend scope when no device id is configured', async () => {
    delete process.env.DEVICE_ID;

    await import('./instrument');

    expect(init).toHaveBeenCalledTimes(1);
    expect(setTag).toHaveBeenCalledWith('ci_portal_url', 'https://hub.ci.computer');
    expect(setTag).toHaveBeenCalledWith('ci_portal_environment', 'prod');
    expect(setTag).toHaveBeenCalledWith('deployment_version', 'v0.2.27');
    expect(setTag).not.toHaveBeenCalledWith('device_id', expect.anything());
    expect(setUser).not.toHaveBeenCalled();
  });

  it('tags hub_image without a tag when the image has no :tag', async () => {
    process.env.CI_HUB_IMAGE = 'ghcr.io/companionintelligence/ci-hub';

    await import('./instrument');

    expect(setTag).toHaveBeenCalledWith('hub_image', 'ghcr.io/companionintelligence/ci-hub');
    expect(setTag).not.toHaveBeenCalledWith('hub_image_tag', expect.anything());
  });
});
