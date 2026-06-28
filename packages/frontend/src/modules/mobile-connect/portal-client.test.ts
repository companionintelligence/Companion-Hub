import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PORTAL_URL, listHubDevices, signInToPortal } from './portal-client';

const httpFetch = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: (...args: unknown[]) => httpFetch(...args),
}));

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

beforeEach(() => {
  httpFetch.mockReset();
});

describe('signInToPortal', () => {
  it('posts email/password to the Portal and returns the session token', async () => {
    httpFetch.mockResolvedValue(json({ token: 'sess-123' }));
    const auth = await signInToPortal('you@example.com', 'pw');

    expect(auth.token).toBe('sess-123');
    const [url, init] = httpFetch.mock.calls[0] ?? [];
    expect(url).toBe(`${DEFAULT_PORTAL_URL}/api/auth/sign-in/email`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ email: 'you@example.com', password: 'pw' });
  });

  it('falls back to session.token and the auth cookie', async () => {
    httpFetch.mockResolvedValue(json({ session: { token: 'nested' } }, { headers: { 'set-cookie': 'ci_session=abc; Path=/; HttpOnly' } }));
    const auth = await signInToPortal('a@b.c', 'pw');
    expect(auth.token).toBe('nested');
    expect(auth.cookie).toContain('ci_session=abc');
  });

  it('honors a custom portal URL', async () => {
    httpFetch.mockResolvedValue(json({ token: 't' }));
    await signInToPortal('a@b.c', 'pw', 'https://staging.example.com/');
    expect(httpFetch.mock.calls[0]?.[0]).toBe('https://staging.example.com/api/auth/sign-in/email');
  });

  it('throws the Portal error message on failure', async () => {
    httpFetch.mockResolvedValue(json({ message: 'Invalid credentials' }, { status: 401 }));
    await expect(signInToPortal('a@b.c', 'bad')).rejects.toThrow('Invalid credentials');
  });

  it('throws when no token and no cookie are returned', async () => {
    httpFetch.mockResolvedValue(json({ user: { id: 1 } }));
    await expect(signInToPortal('a@b.c', 'pw')).rejects.toThrow(/no session/i);
  });
});

describe('listHubDevices', () => {
  it('sends bearer + cookie and maps devices to picker rows', async () => {
    httpFetch.mockResolvedValue(
      json({
        devices: [
          {
            id: 'reg-1',
            displayName: 'Apple Hub',
            status: 'active',
            organizationId: 'org-1',
            apps: [{ slug: 'hub', name: 'OS Hub', url: 'https://hub-apple-acme.ci.computer' }],
          },
          { id: 'reg-2', slug: 'beta', status: 'pending', apps: [] },
        ],
      }),
    );

    const devices = await listHubDevices({ token: 'tok', cookie: 'ci_session=abc' });

    const [, init] = httpFetch.mock.calls[0] ?? [];
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers.Cookie).toBe('ci_session=abc');

    expect(devices).toEqual([
      { id: 'reg-1', name: 'Apple Hub', status: 'active', hubUrl: 'https://hub-apple-acme.ci.computer', organizationId: 'org-1' },
      { id: 'reg-2', name: 'beta', status: 'pending', hubUrl: null, organizationId: undefined },
    ]);
  });

  it('returns [] when the Portal sends no devices array', async () => {
    httpFetch.mockResolvedValue(json({}));
    expect(await listHubDevices({ token: 't', cookie: null })).toEqual([]);
  });

  it('throws on a non-OK device list response', async () => {
    httpFetch.mockResolvedValue(json({}, { status: 500 }));
    await expect(listHubDevices({ token: 't', cookie: null })).rejects.toThrow(/could not load your hubs/i);
  });
});
