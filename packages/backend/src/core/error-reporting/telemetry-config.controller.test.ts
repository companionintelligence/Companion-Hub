import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfigurationService } from '@/core/config/configuration.service';
import { TelemetryConfigController } from './telemetry-config.controller';
import { setUserConsent } from './telemetry-consent';

const controllerWith = (allowErrorMonitoring: unknown) =>
  new TelemetryConfigController({ get: vi.fn(() => ({ allowErrorMonitoring })) } as unknown as ConfigurationService);

describe('TelemetryConfigController', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.CI_TELEMETRY;
    delete process.env.CI_LOCAL_ONLY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('permits reporting when the user has consented', () => {
    expect(controllerWith(true).telemetry()).toEqual({ enabled: true, reason: null });
  });

  it('refuses when the user has turned the switch off', () => {
    expect(controllerWith(false).telemetry()).toEqual({ enabled: false, reason: 'user-disabled' });
  });

  it('refuses under the fleet kill switches', () => {
    process.env.CI_TELEMETRY = 'off';
    expect(controllerWith(true).telemetry()).toEqual({ enabled: false, reason: 'opt-out' });

    process.env.CI_LOCAL_ONLY = 'true';
    expect(controllerWith(true).telemetry()).toEqual({ enabled: false, reason: 'local-only' });
  });

  it('never answers no-dsn: the browser and desktop shell carry their own', () => {
    delete process.env.SENTRY_DSN;
    expect(controllerWith(true).telemetry()).toEqual({ enabled: true, reason: null });
  });

  it('never leaks the DSN', () => {
    process.env.SENTRY_DSN = 'https://public@o1.ingest.sentry.io/2';

    const body = JSON.stringify(controllerWith(true).telemetry());

    expect(body).not.toContain('sentry.io');
    expect(Object.keys(controllerWith(true).telemetry()).sort()).toEqual(['enabled', 'reason']);
  });

  it('falls back to the disk-backed value when configuration is not ready', () => {
    const controller = new TelemetryConfigController({
      get: vi.fn(() => {
        throw new Error('configuration not ready');
      }),
    } as unknown as ConfigurationService);

    setUserConsent(false);
    expect(controller.telemetry()).toEqual({ enabled: false, reason: 'user-disabled' });

    setUserConsent('unreadable');
    expect(controller.telemetry()).toEqual({ enabled: false, reason: 'settings-unreadable' });
  });
});
