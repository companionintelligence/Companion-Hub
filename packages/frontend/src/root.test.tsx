import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistrationStatus } from './lib/registration-status';

const {
  resolveRegistrationStatus,
  userContext,
  requestUse,
  responseUse,
  setConfig,
  captureHubException,
  loadHubSentryDeviceId,
  refreshHubSessionIfDue,
  clearStaleServerSession,
} = vi.hoisted(() => ({
  resolveRegistrationStatus: vi.fn(),
  userContext: vi.fn(),
  requestUse: vi.fn(),
  responseUse: vi.fn(),
  setConfig: vi.fn(),
  captureHubException: vi.fn(),
  loadHubSentryDeviceId: vi.fn(),
  refreshHubSessionIfDue: vi.fn().mockResolvedValue(false),
  clearStaleServerSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./lib/sentry', () => ({
  captureHubException,
  loadHubSentryDeviceId,
}));

vi.mock('./lib/api-fetch', () => ({
  getTauriSessionId: vi.fn(() => null),
  clearStaleServerSession,
}));

vi.mock('./lib/registration-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/registration-cache')>();
  return {
    ...actual,
    resolveRegistrationStatus,
    getCachedRegistrationStatus: vi.fn(() => null),
  };
});

vi.mock('./lib/hub-session-refresh', () => ({
  refreshHubSessionIfDue,
}));

vi.mock('./api-client', () => ({
  userContext,
}));

vi.mock('./api-client/client.gen', () => ({
  client: {
    interceptors: {
      request: { use: requestUse },
      response: { use: responseUse },
    },
    setConfig,
  },
}));

const { clientLoader, ErrorBoundary } = await import('./root');
import { cacheRegistrationStatus } from './lib/registration-cache';

function makeStatus(phase: RegistrationStatus['phase'], registered = false): RegistrationStatus {
  return {
    phase,
    registered,
    degradedReasons: [],
  };
}

describe('root clientLoader registration gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    userContext.mockResolvedValue({
      data: {
        isConfigured: true,
        isLoggedIn: true,
        isGuestDashboardEnabled: false,
      },
    });
  });

  it('redirects non-registration routes when the Hub is explicitly unregistered', async () => {
    resolveRegistrationStatus.mockResolvedValue(makeStatus('unregistered'));

    const result = (await clientLoader({ request: new Request('http://localhost/app-store') } as never)) as Response;

    expect(result.status).toBe(302);
    expect(result.headers.get('Location')).toBe('/device-registration');
  });

  it('keeps the device-registration route available during paired and provisioning phases', async () => {
    resolveRegistrationStatus.mockResolvedValueOnce(makeStatus('paired')).mockResolvedValueOnce(makeStatus('provisioning'));

    const pairedResult = await clientLoader({ request: new Request('http://localhost/device-registration') } as never);
    const provisioningResult = await clientLoader({ request: new Request('http://localhost/device-registration') } as never);

    expect(pairedResult).toBeNull();
    expect(provisioningResult).toBeNull();
  });

  it('redirects root to device registration when registration status is unavailable during startup', async () => {
    resolveRegistrationStatus.mockResolvedValue(null);
    userContext.mockRejectedValue(new Error('backend unavailable'));

    const result = (await clientLoader({ request: new Request('http://localhost/') } as never)) as Response;

    expect(result.status).toBe(302);
    expect(result.headers.get('Location')).toBe('/device-registration');
  });

  it('redirects bootstrap routes to device registration when status is temporarily unavailable', async () => {
    resolveRegistrationStatus.mockResolvedValue(null);

    const rootResult = (await clientLoader({ request: new Request('http://localhost/') } as never)) as Response;
    const loginResult = await clientLoader({ request: new Request('http://localhost/login') } as never);

    expect(rootResult.status).toBe(302);
    expect(rootResult.headers.get('Location')).toBe('/device-registration');
    expect(loginResult).toBeNull();
  });

  it('allows login when registration status is temporarily unavailable', async () => {
    resolveRegistrationStatus.mockResolvedValue(null);

    const loginWithPortalError = (await clientLoader({
      request: new Request('http://localhost/login?portal_error=callback_error'),
    } as never)) as Response | null;

    expect(loginWithPortalError).toBeNull();
  });

  it('allows login while device registration is still pending', async () => {
    resolveRegistrationStatus.mockResolvedValue(makeStatus('unregistered'));

    const result = await clientLoader({ request: new Request('http://localhost/login') } as never);

    expect(result).toBeNull();
  });

  it('does not force re-registration when registration status is temporarily unavailable', async () => {
    const userResult = {
      data: {
        isConfigured: true,
        isLoggedIn: true,
        isGuestDashboardEnabled: false,
      },
    };
    resolveRegistrationStatus.mockResolvedValue(null);
    userContext.mockResolvedValue(userResult);

    const result = await clientLoader({ request: new Request('http://localhost/app-store') } as never);

    expect(result).toBe(userResult);
    expect(userContext).toHaveBeenCalledTimes(1);
  });

  it('redirects away from device registration when the Hub is already operational', async () => {
    resolveRegistrationStatus.mockImplementation(async () => {
      const status = makeStatus('degraded', true);
      cacheRegistrationStatus(status);
      return status;
    });

    const result = (await clientLoader({ request: new Request('http://localhost/device-registration') } as never)) as Response;

    expect(result.status).toBe(302);
    expect(result.headers.get('Location')).toBe('/');
    expect(sessionStorage.getItem('device-registered')).toBe('true');
  });
});

describe('root clientLoader session continuity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    resolveRegistrationStatus.mockResolvedValue(makeStatus('locally_ready', true));
  });

  it('refreshes hub session when user is logged in', async () => {
    userContext.mockResolvedValue({
      data: {
        isConfigured: true,
        isLoggedIn: true,
        isGuestDashboardEnabled: false,
      },
    });

    await clientLoader({ request: new Request('http://localhost/app-store') } as never);

    expect(refreshHubSessionIfDue).toHaveBeenCalledOnce();
    expect(clearStaleServerSession).not.toHaveBeenCalled();
  });

  it('clears stale server session when user is logged out', async () => {
    userContext.mockResolvedValue({
      data: {
        isConfigured: true,
        isLoggedIn: false,
        isGuestDashboardEnabled: false,
      },
    });

    await clientLoader({ request: new Request('http://localhost/app-store') } as never);

    expect(clearStaleServerSession).toHaveBeenCalledOnce();
    expect(refreshHubSessionIfDue).not.toHaveBeenCalled();
  });
});

describe('root ErrorBoundary Sentry capture', () => {
  const env = import.meta.env as { DEV: boolean };
  let originalDev: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    originalDev = env.DEV;
    env.DEV = false;
  });

  afterEach(() => {
    env.DEV = originalDev;
  });

  it('captures route error responses with their HTTP fields instead of [object Object]', () => {
    const routeError = { status: 503, statusText: 'Service Unavailable', internal: false, data: { reason: 'hub down' } };

    ErrorBoundary({ error: routeError } as never);

    expect(captureHubException).toHaveBeenCalledTimes(1);
    const firstCall = captureHubException.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) throw new Error('Expected captureHubException to be called');
    const [capturedError, context] = firstCall;
    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toBe('Route error 503: Service Unavailable');
    expect(context).toEqual({ status: 503, statusText: 'Service Unavailable', data: { reason: 'hub down' } });
  });

  it('captures Error instances as-is', () => {
    const thrown = new Error('boom');

    ErrorBoundary({ error: thrown } as never);

    expect(captureHubException).toHaveBeenCalledWith(thrown);
  });

  it('serializes non-error throwables and preserves the raw value as context', () => {
    const thrown = { code: 'WEIRD' };

    ErrorBoundary({ error: thrown } as never);

    const firstCall = captureHubException.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) throw new Error('Expected captureHubException to be called');
    const [capturedError, context] = firstCall;
    expect((capturedError as Error).message).toBe('Non-error thrown in route boundary: {"code":"WEIRD"}');
    expect(context).toEqual({ rawError: thrown });
  });

  it('does not report in dev mode', () => {
    env.DEV = true;

    ErrorBoundary({ error: new Error('dev only') } as never);

    expect(captureHubException).not.toHaveBeenCalled();
  });
});
