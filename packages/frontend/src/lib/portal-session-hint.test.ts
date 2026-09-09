import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPortalSessionEmailDirect,
  forgetPortalAccountEmail,
  readRememberedPortalAccountEmail,
  rememberPortalAccountEmail,
  resolvePortalSessionHint,
} from './portal-session-hint';

const { mockIsMobile } = vi.hoisted(() => ({ mockIsMobile: vi.fn(() => false) }));

vi.mock('@/lib/mobile-connection', () => ({
  isMobileClient: () => mockIsMobile(),
}));

vi.mock('@/api-client/sdk.gen', () => ({
  portalSessionHint: vi.fn(),
}));

import { portalSessionHint } from '@/api-client/sdk.gen';

describe('portal-session-hint', () => {
  beforeEach(() => {
    localStorage.clear();
    mockIsMobile.mockReturnValue(false);
    vi.mocked(portalSessionHint).mockReset();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns the hub session hint when available', async () => {
    vi.mocked(portalSessionHint).mockResolvedValue({
      data: {
        email: 'operator@example.com',
        portalBaseUrl: 'https://ci-portal.localhost',
        source: 'hub_operator',
      },
      error: undefined,
      request: new Request('http://localhost/api/portal/session-hint'),
      response: { ok: true } as Response,
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no portal session'));

    await expect(resolvePortalSessionHint()).resolves.toEqual({
      email: 'operator@example.com',
      portalBaseUrl: 'https://ci-portal.localhost',
      source: 'hub_operator',
    });
    expect(readRememberedPortalAccountEmail()).toBeNull();
  });

  it('persists a live Portal session and prefers it over the Hub operator', async () => {
    vi.mocked(portalSessionHint).mockResolvedValue({
      data: {
        email: 'hello@lifescope.io',
        portalBaseUrl: 'https://ci-portal.localhost',
        source: 'portal_session',
      },
      error: undefined,
      request: new Request('http://localhost/api/portal/session-hint'),
      response: { ok: true } as Response,
    });

    await expect(resolvePortalSessionHint()).resolves.toEqual({
      email: 'hello@lifescope.io',
      portalBaseUrl: 'https://ci-portal.localhost',
      source: 'portal_session',
    });
    expect(readRememberedPortalAccountEmail()).toBe('hello@lifescope.io');
  });

  it('falls back to a direct Portal session probe when the hub hint has no email', async () => {
    vi.mocked(portalSessionHint).mockResolvedValue({
      data: {
        email: '',
        portalBaseUrl: 'https://ci-portal.localhost',
        source: 'hub_operator',
      } as Awaited<ReturnType<typeof portalSessionHint>>['data'],
      error: undefined,
      request: new Request('http://localhost/api/portal/session-hint'),
      response: { ok: true } as Response,
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ user: { email: 'portal@example.com' } }), { status: 200 }));

    await expect(resolvePortalSessionHint()).resolves.toEqual({
      email: 'portal@example.com',
      portalBaseUrl: 'https://ci-portal.localhost',
      source: 'portal_session',
    });
  });

  it('uses a remembered email when live probes fail', async () => {
    rememberPortalAccountEmail('remembered@example.com');

    vi.mocked(portalSessionHint).mockResolvedValue({
      data: {
        email: '',
        portalBaseUrl: 'https://ci-portal.localhost',
        source: 'hub_operator',
      } as Awaited<ReturnType<typeof portalSessionHint>>['data'],
      error: undefined,
      request: new Request('http://localhost/api/portal/session-hint'),
      response: { ok: true } as Response,
    });

    await expect(resolvePortalSessionHint()).resolves.toEqual({
      email: 'remembered@example.com',
      portalBaseUrl: 'https://ci-portal.localhost',
      source: 'remembered',
    });
  });

  it('on a phone, prefers the remembered Portal user over the Hub operator', async () => {
    mockIsMobile.mockReturnValue(true);
    rememberPortalAccountEmail('user@example.com');

    vi.mocked(portalSessionHint).mockResolvedValue({
      data: {
        email: 'support@example.com',
        portalBaseUrl: 'https://hub.ci.computer',
        source: 'hub_operator',
      },
      error: undefined,
      request: new Request('http://localhost/api/portal/session-hint'),
      response: { ok: true } as Response,
    });

    await expect(resolvePortalSessionHint()).resolves.toEqual({
      email: 'user@example.com',
      portalBaseUrl: 'https://hub.ci.computer',
      source: 'remembered',
    });
    expect(readRememberedPortalAccountEmail()).toBe('user@example.com');
  });

  it('forgetPortalAccountEmail drops the sticky hint', () => {
    rememberPortalAccountEmail('hello@lifescope.io');
    forgetPortalAccountEmail();
    expect(readRememberedPortalAccountEmail()).toBeNull();
  });

  it('parses direct portal session responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ user: { email: '  portal@example.com ' } }), { status: 200 }));

    await expect(fetchPortalSessionEmailDirect('https://ci-portal.localhost/')).resolves.toBe('portal@example.com');
  });
});
