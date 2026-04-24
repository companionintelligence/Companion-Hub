import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistrationStatus } from './lib/registration-status';

const { apiFetch, userContext, requestUse, responseUse, setConfig } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  userContext: vi.fn(),
  requestUse: vi.fn(),
  responseUse: vi.fn(),
  setConfig: vi.fn(),
}));

vi.mock('./lib/api-fetch', () => ({
  apiFetch,
  getTauriSessionId: vi.fn(() => null),
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

const { clientLoader } = await import('./root');

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

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
    apiFetch.mockResolvedValue(jsonResponse(makeStatus('unregistered')));

    const result = (await clientLoader({ request: new Request('http://localhost/app-store') } as never)) as Response;

    expect(result.status).toBe(302);
    expect(result.headers.get('Location')).toBe('/device-registration');
  });

  it('keeps the device-registration route available during paired and provisioning phases', async () => {
    apiFetch.mockResolvedValueOnce(jsonResponse(makeStatus('paired'))).mockResolvedValueOnce(jsonResponse(makeStatus('provisioning')));

    const pairedResult = await clientLoader({ request: new Request('http://localhost/device-registration') } as never);
    const provisioningResult = await clientLoader({ request: new Request('http://localhost/device-registration') } as never);

    expect(pairedResult).toBeNull();
    expect(provisioningResult).toBeNull();
  });

  it('does not force re-registration when registration status is temporarily unavailable', async () => {
    const userResult = {
      data: {
        isConfigured: true,
        isLoggedIn: true,
        isGuestDashboardEnabled: false,
      },
    };
    apiFetch.mockRejectedValue(new Error('temporary outage'));
    userContext.mockResolvedValue(userResult);

    const result = await clientLoader({ request: new Request('http://localhost/app-store') } as never);

    expect(result).toBe(userResult);
    expect(userContext).toHaveBeenCalledTimes(1);
  });

  it('redirects away from device registration when the Hub is already operational', async () => {
    apiFetch.mockResolvedValue(jsonResponse(makeStatus('degraded', true)));

    const result = (await clientLoader({ request: new Request('http://localhost/device-registration') } as never)) as Response;

    expect(result.status).toBe(302);
    expect(result.headers.get('Location')).toBe('/');
    expect(sessionStorage.getItem('device-registered')).toBe('true');
  });
});
