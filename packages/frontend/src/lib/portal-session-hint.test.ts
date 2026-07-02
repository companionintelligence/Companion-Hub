import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPortalSessionEmailDirect,
  readRememberedPortalAccountEmail,
  rememberPortalAccountEmail,
  resolvePortalSessionHint,
} from './portal-session-hint';

vi.mock('@/api-client/sdk.gen', () => ({
  portalSessionHint: vi.fn(),
}));

import { portalSessionHint } from '@/api-client/sdk.gen';

describe('portal-session-hint', () => {
  beforeEach(() => {
    localStorage.clear();
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
      response: { ok: true } as Response,
    });

    await expect(resolvePortalSessionHint()).resolves.toEqual({
      email: 'operator@example.com',
      portalBaseUrl: 'https://ci-portal.localhost',
      source: 'hub_operator',
    });
    expect(readRememberedPortalAccountEmail()).toBe('operator@example.com');
  });

  it('falls back to a direct Portal session probe when the hub hint has no email', async () => {
    vi.mocked(portalSessionHint).mockResolvedValue({
      data: {
        email: null,
        portalBaseUrl: 'https://ci-portal.localhost',
        source: null,
      },
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
        email: null,
        portalBaseUrl: 'https://ci-portal.localhost',
        source: null,
      },
      response: { ok: true } as Response,
    });

    await expect(resolvePortalSessionHint()).resolves.toEqual({
      email: 'remembered@example.com',
      portalBaseUrl: 'https://ci-portal.localhost',
      source: 'remembered',
    });
  });

  it('parses direct portal session responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ user: { email: '  portal@example.com ' } }), { status: 200 }));

    await expect(fetchPortalSessionEmailDirect('https://ci-portal.localhost/')).resolves.toBe('portal@example.com');
  });
});
