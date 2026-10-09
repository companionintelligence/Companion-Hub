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
    setContext: ReturnType<typeof vi.fn>;
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
      setContext: vi.fn(),
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

  // Reproduces production Sentry issue dfe2be44b8084d35b76c6d1d282c043d (comfyui): the
  // translated ROCm-missing message reads "This app needs AMD ROCm…" and names no device
  // path, so it must be classified via errorCode, not by regex-matching the message.
  it('classifies a translated ROCm-missing failure via errorCode, not message text', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'comfyui:ci-marketplace',
      phase: 'start',
      message: 'This app needs AMD ROCm. Set up ROCm in AI Settings, then retry.',
      errorCode: 'rocm_kfd_missing',
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining('comfyui:ci-marketplace'), 'warning');
    const scope = lastScope();
    expect(scope.setFingerprint).toHaveBeenCalledWith(['app-failure', 'start', 'rocm-unavailable']);
    expect(scope.setTag).toHaveBeenCalledWith('failure_category', 'user_environment');
    expect(scope.setTag).toHaveBeenCalledWith('error_class', 'rocm-unavailable');
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

  // #1912: one hub timed out against Portal, Cloudflare and its own Postgres in the same minute.
  // Whether that is a broken network or a starved host is not in any message; the report has to
  // carry the host's state, because the host is a customer's and nobody can log in to look.
  it('attaches the host state at the time of the failure', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'n8n:ci-marketplace',
      phase: 'install',
      message: 'timeout of 20000ms exceeded (ECONNABORTED)',
      errorCode: 'portal_timeout',
    });

    const scope = lastScope();
    expect(scope.setContext).toHaveBeenCalledWith(
      'host_health',
      expect.objectContaining({
        cpu_count: expect.any(Number),
        load_avg_1m: expect.any(Number),
        load_per_core_1m: expect.any(Number),
        mem_free_mib: expect.any(Number),
        process_rss_mib: expect.any(Number),
        event_loop_delay_p99_ms: expect.any(Number),
        event_loop_delay_max_ms: expect.any(Number),
      }),
    );
  });

  it('groups every hub that could not reach Portal into one warning, whichever app it was installing', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'n8n:ci-marketplace',
      phase: 'install',
      message: 'timeout of 20000ms exceeded (ECONNABORTED)',
      errorCode: 'portal_timeout',
    });
    service.reportAppFailure({
      appUrn: 'immich:ci-marketplace',
      phase: 'update',
      message: 'getaddrinfo ENOTFOUND hub.ci.computer',
      errorCode: 'portal_unreachable',
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'Marketplace app install failed: n8n:ci-marketplace: timeout of 20000ms exceeded (ECONNABORTED)',
      'warning',
    );
    const [first, second] = scopes.slice(-2);
    expect(first?.setFingerprint).toHaveBeenCalledWith(['app-failure', 'install', 'portal-unreachable']);
    expect(second?.setFingerprint).toHaveBeenCalledWith(['app-failure', 'update', 'portal-unreachable']);
    expect(second?.setTag).toHaveBeenCalledWith('failure_category', 'user_environment');
  });

  it('keeps a Portal error status an error, grouped by cause rather than by app', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'n8n:ci-marketplace',
      phase: 'install',
      message: 'Failed to fetch app files: 503 Service Unavailable',
      errorCode: 'portal_http_error',
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining('503 Service Unavailable'), 'error');
    const scope = lastScope();
    expect(scope.setFingerprint).toHaveBeenCalledWith(['app-failure', 'install', 'portal-http-error']);
    expect(scope.setTag).toHaveBeenCalledWith('failure_category', 'platform');
    expect(scope.setTag).toHaveBeenCalledWith('error_class', 'portal-http-error');
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

  // Reproduces production Sentry issue dfe2be44b8084d35b76c6d1d282c043d: Docker checks compose
  // `devices` entries in order and fails on the first one it can't attach — ComfyUI lists
  // /dev/dri before /dev/kfd, so a host missing both reports /dev/dri in the raw error text.
  it('classifies raw device-missing errors that name /dev/dri or /dev/kfd as ROCm-unavailable', () => {
    expect(
      classifyAppFailure(
        'Error response from daemon: error gathering device information while adding custom device "/dev/dri": no such file or directory',
      ),
    ).toEqual({
      category: 'user_environment',
      errorClass: 'rocm-unavailable',
    });
    expect(
      classifyAppFailure(
        'Error response from daemon: error gathering device information while adding custom device "/dev/kfd": no such file or directory',
      ),
    ).toEqual({
      category: 'user_environment',
      errorClass: 'rocm-unavailable',
    });
  });

  it('prefers a structured errorCode over message-text regexes when both are available', () => {
    expect(classifyAppFailure('This app needs AMD ROCm. Set up ROCm in AI Settings, then retry.', 'rocm_kfd_missing')).toEqual({
      category: 'user_environment',
      errorClass: 'rocm-unavailable',
    });
    expect(classifyAppFailure('This app needs hardware virtualization (KVM). It is not available on this machine.', 'kvm_missing')).toEqual({
      category: 'user_environment',
      errorClass: 'kvm-unavailable',
    });
    expect(
      classifyAppFailure('App network range conflict — Hub is reassigning a new internal network. Retry install or start.', 'network_overlap'),
    ).toEqual({
      category: 'user_environment',
      errorClass: 'network-overlap',
    });
  });

  it('falls back to message-text classification when the errorCode is unrecognized', () => {
    expect(classifyAppFailure('write /data/x: no space left on device', 'some_future_code')).toEqual({
      category: 'user_environment',
      errorClass: 'disk-full',
    });
  });

  it('falls back to unknown for novel failures', () => {
    expect(classifyAppFailure('something entirely new broke')).toEqual({
      category: 'unknown',
      errorClass: 'unclassified',
    });
  });
});
