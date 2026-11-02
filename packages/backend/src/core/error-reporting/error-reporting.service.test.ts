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

  it.each([
    ['a queue that dropped the channel', 'Marketplace app start failed: channel is closed', 'queue-unavailable'],
    ['a restart mid-install', 'Install did not finish before Hub restarted. Retry the install.', 'hub-restarted'],
    ['a host file the Hub may not write', "EACCES: permission denied, mkdtemp '/data/app'", 'host-permission-denied'],
    ['a sqlite file on a read-only volume', 'attempt to write a readonly database', 'host-database-file'],
    ['an app the Portal would not hand out', 'APP_INSTALL_PORTAL_DOWNLOAD_UNAUTHORIZED', 'entitlement-refused'],
  ])('groups %s as a warning by error class', (_label, message, errorClass) => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({ appUrn: 'ci-memory:ci-marketplace', phase: 'start', message });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.any(String), 'warning');
    expect(lastScope().setFingerprint).toHaveBeenCalledWith(['app-failure', 'start', errorClass]);
  });

  it('names the host port and the remedy when Docker finds it taken', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'legacy-web:_user',
      phase: 'start',
      message:
        'Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint legacy-web__user-web-1: Bind for 0.0.0.0:18789 failed: port is already allocated',
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.any(String), 'warning');
    const scope = lastScope();
    expect(scope.setTag).toHaveBeenCalledWith('host_port', '18789');
    expect(scope.setExtra).toHaveBeenCalledWith('remedy', expect.stringContaining('Host port 18789 is already in use'));
  });

  it.each([80, 443])('does not capture a conflict on the Hub ingress port %i, which the save refuses', (port) => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'legacy-web:_user',
      phase: 'start',
      message: `Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:${port} failed: port is already allocated`,
    });

    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['a dependency that did not start', 'dependency failed to start: container owncloud exited', 'dependency-failed'],
    ['a one-off service that exited non-zero', 'service "safeos-ollama-pull" didn\'t complete successfully: exit 1', 'service-did-not-complete'],
    [
      'a container the runtime would not start',
      'OCI runtime create failed: runc create failed: unable to start container process',
      'container-start-failed',
    ],
    ['a failed health probe after an update', 'Update failed health probe: Health probe did not pass', 'health-probe-failed'],
    ['an app that refused a connection on its own port', 'connect ECONNREFUSED 127.0.0.9:443', 'app-not-listening'],
    ['a backup the app could not finish', 'Could not delete the data of rb-perm-check, so it was not reset', 'app-data-step-failed'],
    ['a container of the app that keeps restarting', 'mixpost_ci-marketplace-mixpost-1 (Restarting (1) 3 seconds ago)', 'container-exited'],
    [
      'a data volume the app still holds',
      'Volume wordpress_ci-marketplace_data-mariadb is in use by review1965-holder, which is still running; stop the app and try again',
      'volume-in-use',
    ],
  ])('reports %s as a warning, grouped by cause', (_label, message, errorClass) => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({ appUrn: 'some-app:ci-marketplace', phase: 'install', message });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.any(String), 'warning');
    expect(lastScope().setFingerprint).toHaveBeenCalledWith(['app-failure', 'install', errorClass]);
  });

  it.each([
    ['says Permission denied', 'app-summary-service-1 (restarting, exit 126): /app/run.sh: bad interpreter: Permission denied'],
    ['fails to bind a port the Hub holds', 'app-web-1 (exited, exit 1): listen tcp 0.0.0.0:443: bind: address already in use'],
    ['names a reference it cannot resolve', 'app-web-1 (exited, exit 1): failed to resolve reference "registry.local/model:1"'],
    ['has no containers to name', "None of this app's services are running."],
  ])('reports a service that did not come up as a warning under the same cause when its log %s', (_label, message) => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({ appUrn: 'some-app:ci-marketplace', phase: 'start', message, errorCode: 'app_service_failed' });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.any(String), 'warning');
    expect(lastScope().setFingerprint).toHaveBeenCalledWith(['app-failure', 'start', 'container-exited']);
  });

  it('groups a manifest a compose file cannot turn into containers as an app-config error', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({ appUrn: 'port-test:_user', phase: 'start', message: 'invalid containerPort: 70000' });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.any(String), 'error');
    expect(lastScope().setFingerprint).toHaveBeenCalledWith(['app-failure', 'start', 'invalid-app-manifest']);
  });

  it('groups an image reference that does not resolve as an app-config error', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'bad-image:_user',
      phase: 'start',
      message: 'Error response from daemon: failed to resolve reference "docker.io/library/nginx:tag-does-not-exist": not found',
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.any(String), 'error');
    expect(lastScope().setFingerprint).toHaveBeenCalledWith(['app-failure', 'start', 'image-reference-invalid']);
  });

  it('groups a catalog that has no entry for the app under the same app-config class', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({ appUrn: 'burner:ci-marketplace', phase: 'install', message: 'App burner:ci-marketplace not found' });

    expect(lastScope().setFingerprint).toHaveBeenCalledWith(['app-failure', 'install', 'app-not-in-catalog']);
  });

  it('groups a missing catalog entry as an app-config error, not per app', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({ appUrn: 'n8n:ci-marketplace', phase: 'install', message: 'Store not found for n8n:ci-marketplace' });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.any(String), 'error');
    expect(lastScope().setFingerprint).toHaveBeenCalledWith(['app-failure', 'install', 'app-not-in-catalog']);
  });

  it('keeps unclassified failures as errors with per-app grouping', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'home-assistant:ci-marketplace',
      phase: 'start',
      message: 'Something the Hub has no name for went wrong.',
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

  it('attaches the underlying cause as a scrubbed extra of about 1 KB at most', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'jaeger:ci-marketplace',
      phase: 'install',
      message: 'COMMON_AN_ERROR_OCCURRED',
      cause: `timeout of 20000ms exceeded password=hunter2 ${'x'.repeat(2000)}`,
    });

    const cause = lastScope().setExtra.mock.calls.find(([key]) => key === 'cause')?.[1];
    expect(typeof cause).toBe('string');
    expect(cause).toContain('timeout of 20000ms exceeded');
    expect(cause).not.toContain('hunter2');
    expect(cause.length).toBeLessThanOrEqual(1024);
  });

  it('keeps a multi-line failure on one title line, so the cause is not cut off', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'ci-memory:ci-marketplace',
      phase: 'install',
      message:
        'Container ci-memory_ci-marketplace-database-1  Error\ndependency failed to start: container ci-memory_ci-marketplace-database-1 is unhealthy',
    });

    const [title] = vi.mocked(Sentry.captureMessage).mock.calls[0];
    expect(title).toContain('dependency failed to start: container ci-memory_ci-marketplace-database-1 is unhealthy');
    expect(title).not.toContain('\n');
  });

  it('titles a translation key by its cause, and keeps the key as the message', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'jaeger:ci-marketplace',
      phase: 'install',
      message: 'COMMON_AN_ERROR_OCCURRED',
      cause: 'Failed to fetch app files: 503 Service Unavailable',
    });

    const [title] = vi.mocked(Sentry.captureMessage).mock.calls[0];
    expect(title).toContain('Failed to fetch app files: 503 Service Unavailable');
    expect(lastScope().setExtra).toHaveBeenCalledWith('message', 'COMMON_AN_ERROR_OCCURRED');
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
      'warning',
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

  it('reports a start the queue refused while RabbitMQ was not connected as a warning, grouped by cause across apps', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'ci-import-tools:ci-marketplace',
      phase: 'start',
      message: "Queue 'app-events-queue' is unavailable while RabbitMQ is connecting.",
      errorCode: 'queue_unavailable',
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining('ci-import-tools:ci-marketplace'), 'warning');
    const scope = lastScope();
    expect(scope.setFingerprint).toHaveBeenCalledWith(['app-failure', 'start', 'queue-unavailable']);
    expect(scope.setTag).toHaveBeenCalledWith('failure_category', 'user_environment');
    expect(scope.setTag).toHaveBeenCalledWith('error_class', 'queue-unavailable');
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
