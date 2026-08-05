import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/nestjs';
import { classifyAppFailure, ErrorReportingService } from './error-reporting.service';
import { setUserConsent } from './telemetry-consent';

const { scopes } = vi.hoisted(() => ({
  scopes: [] as Array<{
    setTag: ReturnType<typeof vi.fn>;
    setLevel: ReturnType<typeof vi.fn>;
    setExtra: ReturnType<typeof vi.fn>;
    setFingerprint: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@sentry/nestjs', () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn((callback: (scope: (typeof scopes)[number]) => void) => {
    const scope = {
      setTag: vi.fn(),
      setLevel: vi.fn(),
      setExtra: vi.fn(),
      setFingerprint: vi.fn(),
    };
    scopes.push(scope);
    callback(scope);
  }),
}));

function lastScope() {
  const scope = scopes.at(-1);
  if (!scope) {
    throw new Error('expected Sentry.withScope to have created a scope');
  }
  return scope;
}

describe('ErrorReportingService', () => {
  const originalDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    vi.clearAllMocks();
    scopes.length = 0;
    process.env.SENTRY_DSN = 'https://example@ingest.sentry.io/123';
  });

  afterEach(() => {
    if (originalDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalDsn;
    }
  });

  it('includes the failure message in the Sentry issue title', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'cryptpad:ci-marketplace',
      phase: 'install',
      message: 'manifest for cryptpad/cryptpad:2026.5.1 not found',
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'Marketplace app install failed: cryptpad:ci-marketplace: manifest for cryptpad/cryptpad:2026.5.1 not found',
      'error',
    );
  });

  it('reports user-environment failures as warnings grouped by error class', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'rembg:ci-marketplace',
      phase: 'install',
      message: 'no matching manifest for linux/arm64/v8 in the manifest list entries',
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining('rembg:ci-marketplace'), 'warning');
    const scope = lastScope();
    expect(scope.setFingerprint).toHaveBeenCalledWith(['app-failure', 'install', 'image-arch-unsupported']);
    expect(scope.setTag).toHaveBeenCalledWith('failure_category', 'user_environment');
    expect(scope.setTag).toHaveBeenCalledWith('error_class', 'image-arch-unsupported');
  });

  it('keeps unclassified failures as errors with per-app grouping', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'home-assistant:ci-marketplace',
      phase: 'start',
      message: 'Error generating docker-compose.yml file for app home-assistant:ci-marketplace.',
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.any(String), 'error');
    const scope = lastScope();
    expect(scope.setFingerprint).toHaveBeenCalledWith(['app-failure', 'home-assistant:ci-marketplace', 'start']);
  });

  it('titles crash-phase reports as a crash, not "crash failed"', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'comfyui:ci-marketplace',
      phase: 'crash',
      message: 'App transitioned from running to stopped during status sync',
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'Marketplace app crashed: comfyui:ci-marketplace: App transitioned from running to stopped during status sync',
      'error',
    );
  });
});

describe('ErrorReportingService consent gating', () => {
  const originalEnv = { ...process.env };

  const serviceWith = (allowErrorMonitoring: unknown) => new ErrorReportingService({ get: vi.fn(() => ({ allowErrorMonitoring })) } as any);

  beforeEach(() => {
    vi.clearAllMocks();
    scopes.length = 0;
    process.env.SENTRY_DSN = 'https://example@ingest.sentry.io/123';
    delete process.env.CI_TELEMETRY;
    delete process.env.CI_LOCAL_ONLY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reports when the user has consented and a DSN is configured', () => {
    expect(serviceWith(true).isEnabled()).toBe(true);
  });

  it('stops reporting when the user turns the switch off', () => {
    const service = serviceWith(false);

    expect(service.isEnabled()).toBe(false);

    service.captureException(new Error('boom'));
    service.captureMessage('nope');
    service.addBreadcrumb('test', 'nope');
    service.reportAppFailure({ appUrn: 'x:ci-marketplace', phase: 'install', message: 'nope' });

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('still requires a DSN', () => {
    delete process.env.SENTRY_DSN;
    expect(serviceWith(true).isEnabled()).toBe(false);
  });

  it('honours the fleet kill switches over the user setting', () => {
    process.env.CI_TELEMETRY = 'off';
    expect(serviceWith(true).isEnabled()).toBe(false);

    delete process.env.CI_TELEMETRY;
    process.env.CI_LOCAL_ONLY = 'true';
    expect(serviceWith(true).isEnabled()).toBe(false);
  });

  it('falls back to the disk-backed value when configuration is not ready', () => {
    const service = new ErrorReportingService({
      get: vi.fn(() => {
        throw new Error('configuration not ready');
      }),
    } as any);

    setUserConsent(false);
    expect(service.isEnabled()).toBe(false);

    setUserConsent(true);
    expect(service.isEnabled()).toBe(true);
  });

  it('falls back to the disk-backed value when the setting is not a boolean', () => {
    setUserConsent(false);
    expect(serviceWith('yes').isEnabled()).toBe(false);
    expect(serviceWith(undefined).isEnabled()).toBe(false);
  });
});

describe('classifyAppFailure', () => {
  it('classifies user-environment failures by root cause', () => {
    expect(classifyAppFailure('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')).toEqual({
      category: 'user_environment',
      errorClass: 'docker-daemon-unreachable',
    });
    expect(classifyAppFailure('ports are not available: exposing port TCP 0.0.0.0:8642')).toEqual({
      category: 'user_environment',
      errorClass: 'port-conflict',
    });
    expect(classifyAppFailure('write /data/x: no space left on device')).toEqual({
      category: 'user_environment',
      errorClass: 'disk-full',
    });
    expect(classifyAppFailure('toomanyrequests: You have reached your unauthenticated pull rate limit')).toEqual({
      category: 'user_environment',
      errorClass: 'registry-rate-limit',
    });
    expect(classifyAppFailure('could not select device driver "nvidia" with capabilities: [[gpu]]')).toEqual({
      category: 'user_environment',
      errorClass: 'device-driver-missing',
    });
  });

  it('classifies broken manifests as app_config', () => {
    expect(classifyAppFailure('Invalid dynamic compose schema: [ … ]')).toEqual({
      category: 'app_config',
      errorClass: 'invalid-compose-schema',
    });
  });

  it('falls back to unknown for novel failures', () => {
    expect(classifyAppFailure('something entirely new broke')).toEqual({
      category: 'unknown',
      errorClass: 'unclassified',
    });
  });
});
