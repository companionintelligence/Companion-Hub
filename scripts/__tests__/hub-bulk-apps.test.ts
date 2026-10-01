/**
 * The sweep routes as the CLI calls them.
 *
 * `cihub app stop-managed` stops containers behind the Hub's back; these go through the Hub, so what
 * matters is that each action reaches the right route with the right verb, that the key rides along,
 * and that every way the Hub can say no — or not answer — comes back as something the command can
 * tell apart.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubClaimNoDeviceKey, HubClaimRefused } from '../lib/hub-claim.js';
import { BULK_APP_ACTIONS, type BulkAppAction, HubBulkRequestTimedOut, isBulkAppAction, requestBulkAppAction } from '../lib/hub-bulk-apps.js';
import { HubUnreachableError } from '../public-web-cli.js';

const mocks = vi.hoisted(() => ({
  readHubApiKeySource: vi.fn(),
  resolveHubApiBase: vi.fn(),
}));

vi.mock('../public-web-cli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-web-cli.js')>()),
  readHubApiKeySource: mocks.readHubApiKeySource,
  resolveHubApiBase: mocks.resolveHubApiBase,
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveHubApiBase.mockReturnValue('http://127.0.0.1:5002');
  mocks.readHubApiKeySource.mockReturnValue({ key: 'host-local-key', found: '/data/state/settings.json', checked: [] });
  fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isBulkAppAction', () => {
  it.each(Object.keys(BULK_APP_ACTIONS))('recognises %s', (action) => {
    expect(isBulkAppAction(action)).toBe(true);
  });

  it.each(['start', 'stop', 'list', 'stop-managed', 'remove-managed', '', 'START-ALL', 'constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'does not mistake %j for a sweep',
    (value) => {
      expect(isBulkAppAction(value)).toBe(false);
    },
  );
});

describe('requestBulkAppAction', () => {
  it.each([
    ['start-all', 'POST', '/api/app-lifecycle/start-all'],
    ['stop-all', 'POST', '/api/app-lifecycle/stop-all'],
    ['restart-all', 'POST', '/api/app-lifecycle/restart-all'],
    ['update-all', 'PATCH', '/api/app-lifecycle/update-all'],
  ] as const)('sends %s as %s %s with the device key', async (action, method, route) => {
    await requestBulkAppAction('/data/.env.dev', action);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:5002${route}`);
    expect(init.method).toBe(method);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer host-local-key');
  });

  it('reads the base address and the key from the env file it was given', async () => {
    await requestBulkAppAction('/srv/hub/.env', 'stop-all');

    expect(mocks.resolveHubApiBase).toHaveBeenCalledWith('/srv/hub/.env');
    expect(mocks.readHubApiKeySource).toHaveBeenCalledWith('/srv/hub/.env');
  });

  it('resolves for an empty 201, which is what the Hub answers', async () => {
    await expect(requestBulkAppAction('/data/.env.dev', 'start-all')).resolves.toBeUndefined();
  });

  it('refuses before sending anything when this machine holds no key', async () => {
    mocks.readHubApiKeySource.mockReturnValue({ checked: ['/data/state/settings.json', '/etc/ci-hub/settings.json'] });

    const failure = await requestBulkAppAction('/data/.env.dev', 'stop-all').catch((error) => error);

    expect(failure).toBeInstanceOf(HubClaimNoDeviceKey);
    expect((failure as HubClaimNoDeviceKey).checked).toEqual(['/data/state/settings.json', '/etc/ci-hub/settings.json']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says the Hub is not reachable, with where it looked, when nothing answers', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const failure = await requestBulkAppAction('/data/.env.dev', 'start-all').catch((error) => error);

    expect(failure).toBeInstanceOf(HubUnreachableError);
    expect((failure as Error).message).toContain('http://127.0.0.1:5002');
    expect((failure as Error).message).toContain('fetch failed');
  });

  it('says the Hub was slow, not absent, when it does not answer in time', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));

    const failure = await requestBulkAppAction('/data/.env.dev', 'update-all').catch((error) => error);

    expect(failure).toBeInstanceOf(HubBulkRequestTimedOut);
    expect(failure).not.toBeInstanceOf(HubUnreachableError);
    expect(failure).toMatchObject({ base: 'http://127.0.0.1:5002', seconds: 60 });
  });

  it('gives the request a signal that times out', async () => {
    await requestBulkAppAction('/data/.env.dev', 'update-all');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('hands back the Hub’s refusal with its translation key', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ statusCode: 403, message: 'APP_ACTION_GRANT_DENIED', path: '/api/app-lifecycle/stop-all' }), { status: 403 }),
    );

    const failure = await requestBulkAppAction('/data/.env.dev', 'stop-all').catch((error) => error);

    expect(failure).toBeInstanceOf(HubClaimRefused);
    expect(failure).toMatchObject({ status: 403, code: 'APP_ACTION_GRANT_DENIED' });
  });

  it('keeps the text of an answer that is not the Hub’s own, such as a proxy’s error page', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 }));

    const failure = await requestBulkAppAction('/data/.env.dev', 'update-all').catch((error) => error);

    expect(failure).toBeInstanceOf(HubClaimRefused);
    expect(failure).toMatchObject({ status: 502, code: undefined });
    expect((failure as Error).message).toContain('Bad Gateway');
  });

  it('describes every action it can send', () => {
    for (const action of Object.keys(BULK_APP_ACTIONS) as BulkAppAction[]) {
      expect(BULK_APP_ACTIONS[action].requested).toMatch(/requested/);
    }
  });
});
