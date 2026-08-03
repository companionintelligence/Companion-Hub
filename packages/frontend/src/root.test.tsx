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

const { handleSessionExpired } = vi.hoisted(() => ({ handleSessionExpired: vi.fn() }));

vi.mock('./lib/session-expired', () => ({ handleSessionExpired }));

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

// Captured at import time: `beforeEach(vi.clearAllMocks)` would otherwise wipe the
// registration call this interceptor arrived on.
const responseInterceptor = responseUse.mock.calls[0]?.[0] as (res: Response) => Promise<Response>;

/** The interceptor only reads these, and `Response.url` cannot be set via the constructor. */
const errorResponse = (url: string, status = 401) => ({ status, url, statusText: 'Unauthorized', text: async () => '' }) as unknown as Response;

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

  it('keeps root on the startup bootstrap route when registration status is temporarily unavailable', async () => {
    resolveRegistrationStatus.mockResolvedValue(null);
    userContext.mockRejectedValue(new Error('backend unavailable'));

    const result = await clientLoader({ request: new Request('http://localhost/') } as never);

    expect(result).toBeNull();
  });

  it('keeps login and root available when registration status is temporarily unavailable', async () => {
    resolveRegistrationStatus.mockResolvedValue(null);

    const rootResult = await clientLoader({ request: new Request('http://localhost/') } as never);
    const loginResult = await clientLoader({ request: new Request('http://localhost/login') } as never);

    expect(rootResult).toBeNull();
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
    expect(result.headers.get('Location')).toBe('/login');
    expect(sessionStorage.getItem('device-registered')).toBe('true');
  });

  it('does not hijack navigation when only the public tunnel is degraded', async () => {
    const userResult = {
      data: { isConfigured: true, isLoggedIn: true, isGuestDashboardEnabled: false },
    };
    userContext.mockResolvedValue(userResult);
    resolveRegistrationStatus.mockResolvedValue({
      phase: 'degraded',
      registered: true,
      degradedReasons: ['tunnel_token_missing'],
    });

    const result = await clientLoader({ request: new Request('http://localhost/settings') } as never);

    // The Hub is registered and works locally — stay on the requested page
    // instead of redirecting to the re-pair screen.
    expect(result).toBe(userResult);
  });

  it('keeps the re-pair screen reachable when the public tunnel is degraded', async () => {
    const userResult = {
      data: { isConfigured: true, isLoggedIn: true, isGuestDashboardEnabled: false },
    };
    userContext.mockResolvedValue(userResult);
    resolveRegistrationStatus.mockResolvedValue({
      phase: 'degraded',
      registered: true,
      degradedReasons: ['tunnel_token_missing'],
    });

    const result = await clientLoader({ request: new Request('http://localhost/device-registration') } as never);

    // No forced bounce to /login — the user can stay and re-pair.
    expect(result).toBe(userResult);
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

describe('root response interceptor 401 handling', () => {
  beforeEach(() => {
    handleSessionExpired.mockClear();
  });

  it('signs the client out when a normal request 401s', async () => {
    await expect(responseInterceptor(errorResponse('http://127.0.0.1:5002/api/apps'))).rejects.toThrow();

    expect(handleSessionExpired).toHaveBeenCalled();
  });

  it('attaches HTTP status and URL to thrown TranslatableError for Sentry', async () => {
    const { TranslatableError } = await import('./types/error.types');
    const res = {
      status: 500,
      url: 'http://127.0.0.1:5002/api/store/listings',
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({ message: 'COMMON_AN_ERROR_OCCURRED' }),
    } as unknown as Response;

    let thrown: unknown;
    try {
      await responseInterceptor(res);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TranslatableError);
    const typed = thrown as InstanceType<typeof TranslatableError>;
    expect(typed.message).toBe('COMMON_AN_ERROR_OCCURRED');
    expect(typed.http).toEqual({
      status: 500,
      url: 'http://127.0.0.1:5002/api/store/listings',
      body: 'COMMON_AN_ERROR_OCCURRED',
    });
  });

  it.each([
    'http://127.0.0.1:5002/api/auth/login',
    'http://127.0.0.1:5002/api/auth/logout',
    'http://127.0.0.1:5002/api/auth/session/refresh',
    // The generated SDK client — not `apiFetch` — is what `openExternalWithHubSession`
    // calls, so the fail-open exemption has to hold on THIS path (#944).
    'http://127.0.0.1:5002/api/auth/browser-handoff/mint',
  ])('leaves the session alone when %s 401s', async (url) => {
    await expect(responseInterceptor(errorResponse(url))).rejects.toThrow();

    expect(handleSessionExpired).not.toHaveBeenCalled();
  });
});
