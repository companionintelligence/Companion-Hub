import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { AuthMiddleware, sessionIdsFromRequest } from '../auth.middleware';
import { SessionManager } from '../session.manager';
import type { Request } from 'express';
import jsonwebtoken from 'jsonwebtoken';

describe('AuthMiddleware transient DB handling', () => {
  const sessionManager = {
    resolveSessionUserId: vi.fn(),
    getSessionExpiresAt: vi.fn(),
    touchSession: vi.fn(),
    destroyAllSessionsByUserId: vi.fn(),
  };
  const config = {
    get: vi.fn(),
  };
  const userRepository = {
    getUserDtoById: vi.fn(),
    getFirstOperator: vi.fn(),
  };
  const sessionUserCache = {
    get: vi.fn().mockReturnValue(undefined),
    beginRead: vi.fn().mockReturnValue({ epoch: 0, version: 0 }),
    set: vi.fn(),
    invalidate: vi.fn(),
  };

  let middleware: AuthMiddleware;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionUserCache.get.mockReturnValue(undefined);
    middleware = new AuthMiddleware(sessionManager as never, config as never, userRepository as never, sessionUserCache as never);
  });

  it('retries EAI_AGAIN on session user lookup then succeeds', async () => {
    const transient = Object.assign(new Error('getaddrinfo EAI_AGAIN ci-hub-db'), { code: 'EAI_AGAIN' });
    sessionManager.resolveSessionUserId.mockReturnValue(1);
    sessionManager.getSessionExpiresAt.mockReturnValue(null);
    userRepository.getUserDtoById.mockRejectedValueOnce(transient).mockResolvedValueOnce({ id: 1, username: 'op' });

    const req = { cookies: { 'ci-hub-sid': 'sess' }, headers: {}, get: () => undefined, query: {} } as never;
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(userRepository.getUserDtoById).toHaveBeenCalledTimes(2);
    expect((req as { user?: { id: number } }).user).toEqual({ id: 1, username: 'op' });
    expect(next).toHaveBeenCalledOnce();
  });

  it('answers 503 when session user lookup stays unreachable', async () => {
    const transient = Object.assign(new Error('getaddrinfo EAI_AGAIN ci-hub-db'), { code: 'EAI_AGAIN' });
    sessionManager.resolveSessionUserId.mockReturnValue(1);
    sessionManager.getSessionExpiresAt.mockReturnValue(null);
    userRepository.getUserDtoById.mockRejectedValue(transient);

    const req = { cookies: { 'ci-hub-sid': 'sess' }, headers: {}, get: () => undefined, query: {} } as never;

    await expect(middleware.use(req, {} as never, vi.fn())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(userRepository.getUserDtoById).toHaveBeenCalledTimes(3);
  });

  it('continues unauthenticated when session user lookup fails with a non-transient error', async () => {
    sessionManager.resolveSessionUserId.mockReturnValue(1);
    sessionManager.getSessionExpiresAt.mockReturnValue(null);
    userRepository.getUserDtoById.mockRejectedValue(new Error('Failed query: select id from user'));

    const req = { cookies: { 'ci-hub-sid': 'sess' }, headers: {}, get: () => undefined, query: {} } as never;
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect((req as { user?: unknown }).user).toBeUndefined();
  });

  it('refuses a revoked operator even when the session id is still live', async () => {
    sessionManager.resolveSessionUserId.mockReturnValue(3);
    sessionManager.getSessionExpiresAt.mockReturnValue(null);
    userRepository.getUserDtoById.mockResolvedValue({ id: 3, username: 'gone@example.com', accessStatus: 'revoked' });
    sessionManager.destroyAllSessionsByUserId.mockResolvedValue(undefined as never);

    const req = { cookies: { 'ci-hub-sid': 'sess' }, headers: {}, get: () => undefined, query: {} } as never;
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(sessionManager.destroyAllSessionsByUserId).toHaveBeenCalledWith(3);
    expect((req as { user?: unknown }).user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('sessionIdsFromRequest', () => {
  it('lists cookie then header then query, skipping duplicates', () => {
    const req = {
      cookies: { 'ci-hub-sid': 'cookie-sess' },
      query: { session_id: 'query-sess' },
      get: (name: string) => (name === 'x-ci-hub-session' ? 'header-sess' : undefined),
    } as unknown as Request;

    expect(sessionIdsFromRequest(req)).toEqual(['cookie-sess', 'header-sess', 'query-sess']);
  });
});

describe('AuthMiddleware session fallback', () => {
  const sessionManager = {
    resolveSessionUserId: vi.fn(),
    getSessionExpiresAt: vi.fn(),
    touchSession: vi.fn(),
    destroyAllSessionsByUserId: vi.fn(),
  };
  const config = {
    get: vi.fn(),
  };
  const userRepository = {
    getUserDtoById: vi.fn(),
    getFirstOperator: vi.fn(),
  };
  const sessionUserCache = {
    get: vi.fn().mockReturnValue(undefined),
    beginRead: vi.fn().mockReturnValue({ epoch: 0, version: 0 }),
    set: vi.fn(),
    invalidate: vi.fn(),
  };

  let middleware: AuthMiddleware;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionUserCache.get.mockReturnValue(undefined);
    middleware = new AuthMiddleware(sessionManager as never, config as never, userRepository as never, sessionUserCache as never);
    sessionManager.getSessionExpiresAt.mockReturnValue(null);
  });

  it('serves session user from cache without hitting the DB', async () => {
    sessionManager.resolveSessionUserId.mockReturnValue(7);
    sessionUserCache.get.mockReturnValue({ id: 7, username: 'cached' });

    const req = { cookies: { 'ci-hub-sid': 'sess' }, headers: {}, get: () => undefined, query: {} } as never;
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(userRepository.getUserDtoById).not.toHaveBeenCalled();
    expect((req as { user?: { id: number } }).user).toEqual({ id: 7, username: 'cached' });
    expect((req as { hubPrincipal?: string }).hubPrincipal).toBe('session');
    expect(next).toHaveBeenCalledOnce();
  });

  it('prefers the newer of a valid cookie and a valid header session', async () => {
    sessionManager.resolveSessionUserId.mockImplementation((id: string) => (id === 'old-sess' ? 1 : id === 'new-sess' ? 2 : null));
    sessionManager.getSessionExpiresAt.mockImplementation((id: string) => (id === 'old-sess' ? 1_000 : id === 'new-sess' ? 9_000 : null));
    userRepository.getUserDtoById.mockResolvedValue({ id: 2, username: 'hello@lifescope.io' });

    const req = {
      cookies: { 'ci-hub-sid': 'old-sess' },
      headers: {},
      query: {},
      get: (name: string) => (name === 'x-ci-hub-session' ? 'new-sess' : undefined),
    } as unknown as Request;
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(req.user).toEqual({ id: 2, username: 'hello@lifescope.io' });
    expect(req.hubSessionId).toBe('new-sess');
  });

  it('authenticates from X-CI-Hub-Session when the cookie session is stale', async () => {
    sessionManager.resolveSessionUserId.mockImplementation((id: string) => (id === 'live-sess' ? 2 : null));
    userRepository.getUserDtoById.mockResolvedValue({ id: 2, username: 'op' });

    const req = {
      cookies: { 'ci-hub-sid': 'stale-sess' },
      headers: {},
      query: {},
      get: (name: string) => (name === 'x-ci-hub-session' ? 'live-sess' : undefined),
    } as unknown as Request;
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(req.user).toEqual({ id: 2, username: 'op' });
    expect(req.hubSessionId).toBe('live-sess');
    expect(req.hubPrincipal).toBe('session');
    expect(next).toHaveBeenCalledOnce();
  });

  it('falls through to the Hub API key when a stale cookie is the only session id', async () => {
    sessionManager.resolveSessionUserId.mockReturnValue(null);
    config.get.mockImplementation((key: string) => (key === 'ciHubApiKey' ? 'hub-api-key' : undefined));
    userRepository.getFirstOperator.mockResolvedValue({ id: 1, username: 'op' });

    const req = {
      cookies: { 'ci-hub-sid': 'stale-sess' },
      headers: { authorization: 'Bearer hub-api-key' },
      query: {},
      get: () => undefined,
    } as unknown as Request;
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(req.user).toEqual({ id: 1, username: 'op' });
    expect(req.hubPrincipal).toBe('portal-device');
    expect(next).toHaveBeenCalledOnce();
  });

  /*
   * `hubPrincipal` is what exempts a caller from the org-grant gate, and an
   * unnamed principal is refused there. An arm that stops naming itself would
   * therefore 403 every Portal push and every `cihub` install, so each arm is
   * pinned here rather than only in the gate's own unit tests, which build their
   * requests by hand.
   */
  it('names the CLI principal for a `sub: cli` JWT', async () => {
    sessionManager.resolveSessionUserId.mockReturnValue(null);
    const token = jsonwebtoken.sign({ sub: 'cli' }, 'jwt-secret');
    config.get.mockImplementation((key: string) => (key === 'jwtSecret' ? 'jwt-secret' : undefined));
    userRepository.getFirstOperator.mockResolvedValue({ id: 1, username: 'op' });

    const req = {
      cookies: {},
      headers: { authorization: `Bearer ${token}` },
      query: {},
      get: () => undefined,
    } as unknown as Request;
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(req.user).toEqual({ id: 1, username: 'op' });
    expect(req.hubPrincipal).toBe('cli');
    expect(next).toHaveBeenCalledOnce();
  });

  it('names no principal for a JWT that is not the CLI', async () => {
    sessionManager.resolveSessionUserId.mockReturnValue(null);
    const token = jsonwebtoken.sign({ sub: 'someone-else' }, 'jwt-secret');
    config.get.mockImplementation((key: string) => (key === 'jwtSecret' ? 'jwt-secret' : undefined));

    const req = {
      cookies: {},
      headers: { authorization: `Bearer ${token}` },
      query: {},
      get: () => undefined,
    } as unknown as Request;
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(req.user).toBeUndefined();
    expect(req.hubPrincipal).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  /**
   * The comparison moved to `timingSafeEqual`, which throws on a length mismatch rather than
   * returning false — so a wrong key of a DIFFERENT length is the case that would surface a
   * careless port of this branch as a 500 instead of an anonymous request.
   */
  it.each([
    ['a wrong key of the same length', 'hub-api-keX'],
    ['a wrong key that is shorter', 'hub-api'],
    ['a wrong key that is longer', 'hub-api-key-with-more'],
    ['an empty-ish bearer', ' '],
  ])('does not authenticate with %s', async (_label, presented) => {
    sessionManager.resolveSessionUserId.mockReturnValue(null);
    config.get.mockImplementation((key: string) => (key === 'ciHubApiKey' ? 'hub-api-key' : undefined));
    userRepository.getFirstOperator.mockResolvedValue({ id: 1, username: 'op' });

    const req = {
      cookies: {},
      headers: { authorization: `Bearer ${presented}` },
      query: {},
      get: () => undefined,
    } as unknown as Request;
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(req.user).toBeUndefined();
    expect(userRepository.getFirstOperator).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

/**
 * The hole that cost the Hub Pool fleet a week.
 *
 * A Hub registered with `cihub register` holds a valid device key and — until somebody signs in
 * through Portal in a browser — has ZERO rows in `user`. Both host-local arms assigned
 * `getFirstOperator()` to `req.user` without checking it, so on those Hubs `req.user` was
 * `undefined` and `AuthGuard` answered "you must be logged in" to a correct key. Twelve of sixteen
 * nodes were in that state, and every one of them was diagnosed as a key problem.
 *
 * What is pinned here is the behaviour that was missing, not the wording: a valid host-local
 * credential on an operator-less Hub must never leave an undefined principal behind, and must be
 * distinguishable from an anonymous caller.
 */
describe('AuthMiddleware on a Hub with no operator', () => {
  const sessionManager = {
    resolveSessionUserId: vi.fn(),
    getSessionExpiresAt: vi.fn(),
    touchSession: vi.fn(),
    destroyAllSessionsByUserId: vi.fn(),
  };
  const config = { get: vi.fn() };
  const userRepository = {
    getUserDtoById: vi.fn(),
    getFirstOperator: vi.fn(),
  };
  const sessionUserCache = {
    get: vi.fn().mockReturnValue(undefined),
    beginRead: vi.fn().mockReturnValue({ epoch: 0, version: 0 }),
    set: vi.fn(),
    invalidate: vi.fn(),
  };

  let middleware: AuthMiddleware;

  const bearerRequest = (token: string) =>
    ({
      cookies: {},
      headers: { authorization: `Bearer ${token}` },
      query: {},
      get: () => undefined,
    }) as unknown as Request;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionUserCache.get.mockReturnValue(undefined);
    sessionManager.resolveSessionUserId.mockReturnValue(null);
    sessionManager.getSessionExpiresAt.mockReturnValue(null);
    middleware = new AuthMiddleware(sessionManager as never, config as never, userRepository as never, sessionUserCache as never);
  });

  it.each([
    ['no operator row at all', null],
    ['a repository that answers undefined', undefined],
  ])('does not install a principal for a valid device key when there is %s', async (_label, operator) => {
    config.get.mockImplementation((key: string) => (key === 'ciHubApiKey' ? 'hub-api-key' : undefined));
    userRepository.getFirstOperator.mockResolvedValue(operator);

    const req = bearerRequest('hub-api-key');
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(req.user).toBeUndefined();
    expect(req.hubUnclaimed).toBe(true);
    // The arm still names itself: "we could not tell who you are" and "this Hub has nobody to be"
    // are different answers, and only the second one has a fix.
    expect(req.hubPrincipal).toBe('portal-device');
    expect(next).toHaveBeenCalledOnce();
  });

  it('leaves the CLI JWT arm in the same honest state', async () => {
    // Same hole, same fix: the JWT is signed with `jwtSecret`, which lives in the same state file
    // as the device key, so it reaches an empty `user` table exactly as often.
    const token = jsonwebtoken.sign({ sub: 'cli' }, 'jwt-secret');
    config.get.mockImplementation((key: string) => (key === 'jwtSecret' ? 'jwt-secret' : undefined));
    userRepository.getFirstOperator.mockResolvedValue(null);

    const req = bearerRequest(token);
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(req.user).toBeUndefined();
    expect(req.hubUnclaimed).toBe(true);
    expect(req.hubPrincipal).toBe('cli');
    expect(next).toHaveBeenCalledOnce();
  });

  it('marks nothing unclaimed once the Hub has an operator', async () => {
    config.get.mockImplementation((key: string) => (key === 'ciHubApiKey' ? 'hub-api-key' : undefined));
    userRepository.getFirstOperator.mockResolvedValue({ id: 1, username: 'op@example.com' });

    const req = bearerRequest('hub-api-key');
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(req.user).toEqual({ id: 1, username: 'op@example.com' });
    expect(req.hubUnclaimed).toBeUndefined();
    expect(req.hubPrincipal).toBe('portal-device');
  });

  it('never reports an anonymous caller as merely unclaimed', async () => {
    // No bearer at all: the Hub's own state is not the reason this request has no user, and saying
    // otherwise would hand a stranger a "run cihub claim" hint about an appliance they cannot touch.
    config.get.mockImplementation((key: string) => (key === 'ciHubApiKey' ? 'hub-api-key' : undefined));

    const req = { cookies: {}, headers: {}, query: {}, get: () => undefined } as unknown as Request;
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(req.hubUnclaimed).toBeUndefined();
    expect(req.hubPrincipal).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});

/**
 * Edge SSO plants an app-scoped session on app hosts, and Traefik copies that cookie to every app
 * served there. However it is presented, it must authenticate nothing on the Hub API. Driven with a
 * real SessionManager, so what refuses it is the key space itself rather than a mock's answer.
 */
describe('AuthMiddleware and app sessions', () => {
  const config = { get: vi.fn() };
  const userRepository = { getUserDtoById: vi.fn(), getFirstOperator: vi.fn() };
  const sessionUserCache = {
    get: vi.fn().mockReturnValue(undefined),
    beginRead: vi.fn().mockReturnValue({ epoch: 0, version: 0 }),
    set: vi.fn(),
    invalidate: vi.fn(),
  };

  function memoryCache() {
    const store = new Map<string, string>();
    return {
      get: (key: string) => store.get(key),
      set: (key: string, value: string) => void store.set(key, value),
      del: (key: string) => void store.delete(key),
      getExpirationAt: (key: string) => (store.has(key) ? Date.now() + 60 * 60 * 1000 : null),
      getByPrefix: (prefix: string) => [...store.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, val]) => ({ key, val })),
    };
  }

  const requestWith = ({ cookies = {}, header, query = {} }: { cookies?: Record<string, string>; header?: string; query?: Record<string, string> }) =>
    ({ cookies, headers: {}, query, get: (name: string) => (name === 'x-ci-hub-session' ? header : undefined) }) as unknown as Request;

  let middleware: AuthMiddleware;
  let parentSessionId: string;
  let appSessionId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    sessionUserCache.get.mockReturnValue(undefined);
    userRepository.getUserDtoById.mockResolvedValue({ id: 7, username: 'op@example.com' });
    const sessionManager = new SessionManager(memoryCache() as never);
    middleware = new AuthMiddleware(sessionManager, config as never, userRepository as never, sessionUserCache as never);
    parentSessionId = await sessionManager.createSession(7);
    appSessionId = (await sessionManager.createAppSession(7, parentSessionId, 'importer:ci-marketplace' as never)) as string;
  });

  it.each([
    ['the Hub session cookie', (id: string) => requestWith({ cookies: { 'ci-hub-sid': id } })],
    ['the X-CI-Hub-Session header', (id: string) => requestWith({ header: id })],
    ['the session_id query parameter', (id: string) => requestWith({ query: { session_id: id } })],
    ['its own app-session cookie', (id: string) => requestWith({ cookies: { 'ci-hub-app-sid': id } })],
  ])('does not accept an app-session id presented in %s', async (_label, build) => {
    const req = build(appSessionId);
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(req.user).toBeUndefined();
    expect(req.hubSessionId).toBeUndefined();
    expect(req.hubPrincipal).toBeUndefined();
    expect(userRepository.getUserDtoById).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('still accepts the Hub session the app session was derived from', async () => {
    // The control for the refusals above: this harness does authenticate a real session id.
    const req = requestWith({ cookies: { 'ci-hub-sid': parentSessionId } });

    await middleware.use(req, {} as never, vi.fn());

    expect(req.user).toEqual({ id: 7, username: 'op@example.com' });
    expect(req.hubPrincipal).toBe('session');
  });
});

/**
 * The `qa:read` arm. What is pinned is that it names a principal and installs NO user — every guard
 * that asks "is there an operator here" must keep saying no — and that it costs no key-store lookup
 * for anything that was never going to be such a key. A real `ApiKeyService` over an in-memory table,
 * so the scope check is the service's own and not a mock's answer.
 */
describe('AuthMiddleware and qa:read API keys', () => {
  const QA_KEY = 'a'.repeat(64);
  const MCP_KEY = 'b'.repeat(64);
  const INFERENCE_KEY = 'c'.repeat(64);

  const sessionManager = {
    resolveSessionUserId: vi.fn(),
    getSessionExpiresAt: vi.fn(),
    touchSession: vi.fn(),
    destroyAllSessionsByUserId: vi.fn(),
  };
  const config = { get: vi.fn() };
  const userRepository = { getUserDtoById: vi.fn(), getFirstOperator: vi.fn() };
  const sessionUserCache = { get: vi.fn(), beginRead: vi.fn(), set: vi.fn(), invalidate: vi.fn() };

  const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');
  const rows = new Map([
    [sha256(QA_KEY), { id: 1, name: 'fleet-qa', scopes: ['qa:read'], capability: 'read', managed: false, ownerAppUrn: null, expiresAt: null }],
    [sha256(MCP_KEY), { id: 2, name: 'laptop', scopes: ['mcp'], capability: 'write', managed: false, ownerAppUrn: null, expiresAt: null }],
    [
      sha256(INFERENCE_KEY),
      { id: 3, name: 'laptop-zed', scopes: ['inference'], capability: 'read', managed: false, ownerAppUrn: null, expiresAt: null },
    ],
  ]);
  const repo = { findByHash: vi.fn(), touchLastUsed: vi.fn() };

  let middleware: AuthMiddleware;

  const bearer = (token: string, originalUrl = '/api/inference/pool/routing-log', method = 'GET') =>
    ({
      cookies: {},
      headers: { authorization: `Bearer ${token}` },
      query: {},
      get: () => undefined,
      method,
      originalUrl,
      url: originalUrl,
    }) as unknown as Request;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionManager.resolveSessionUserId.mockReturnValue(null);
    sessionManager.getSessionExpiresAt.mockReturnValue(null);
    config.get.mockImplementation((key: string) => (key === 'jwtSecret' ? 'jwt-secret' : undefined));
    repo.findByHash.mockImplementation(async (hash: string) => rows.get(hash));
    repo.touchLastUsed.mockResolvedValue(undefined);
    const apiKeys = new ApiKeyService(repo as never, { warn: vi.fn(), info: vi.fn() } as never);
    middleware = new AuthMiddleware(sessionManager as never, config as never, userRepository as never, sessionUserCache as never, apiKeys);
  });

  it('names a qa:read key as its own principal and installs no user', async () => {
    const req = bearer(QA_KEY);
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(req.hubPrincipal).toBe('qa-read');
    expect(req.user).toBeUndefined();
    expect(req.hubUnclaimed).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('leaves an mcp key unauthenticated on the REST surface, exactly as before', async () => {
    const req = bearer(MCP_KEY);

    await middleware.use(req, {} as never, vi.fn());

    expect(req.hubPrincipal).toBeUndefined();
    expect(req.user).toBeUndefined();
  });

  /**
   * An inference key is stored as `read`, the same capability a qa:read key carries, and it reaches
   * this arm on every GET an editor makes from outside the appliance (`InferenceAccessGuard` runs
   * after the middleware). Scope, not capability, is what keeps it from becoming the `qa-read`
   * principal: a leaked editor credential must open GPU time and nothing else.
   */
  it('leaves an inference key unauthenticated on the REST surface — read-only is not the same as qa-read', async () => {
    const req = bearer(INFERENCE_KEY);

    await middleware.use(req, {} as never, vi.fn());

    expect(req.hubPrincipal).toBeUndefined();
    expect(req.user).toBeUndefined();
  });

  it('never looks up a token that is not shaped like a Hub key', async () => {
    await middleware.use(bearer('not-a-hub-key'), {} as never, vi.fn());
    await middleware.use(bearer(jsonwebtoken.sign({ sub: 'someone-else' }, 'other-secret')), {} as never, vi.fn());

    expect(repo.findByHash).not.toHaveBeenCalled();
  });

  /**
   * A pool peer still on the bearer path sends a 64-hex token on every `POST /local/*` forward, and an
   * app callback sends its managed key. Looking those up bought a SELECT per forward — and, while the
   * database was down, 550 ms of retries and two warn lines per request — for a principal that no
   * write route admits.
   */
  it.each([
    ['a peer forward', '/api/inference/pool/local/v1/chat/completions', 'POST'],
    ['an app callback', '/api/memory-connect/apps/x/skip', 'POST'],
  ])('never looks a key up on a write (%s), where it could not be admitted anyway', async (_label, url, method) => {
    const req = bearer(QA_KEY, url, method);

    await middleware.use(req, {} as never, vi.fn());

    expect(repo.findByHash).not.toHaveBeenCalled();
    expect(req.hubPrincipal).toBeUndefined();
  });

  it('looks a key up on a HEAD, which Express serves from the GET handler', async () => {
    const req = bearer(QA_KEY, '/api/inference/pool/status', 'HEAD');

    await middleware.use(req, {} as never, vi.fn());

    expect(req.hubPrincipal).toBe('qa-read');
  });

  it('skips /api/mcp, whose own guard already looks every key up', async () => {
    const req = bearer(QA_KEY, '/api/mcp?session=1');

    await middleware.use(req, {} as never, vi.fn());

    expect(repo.findByHash).not.toHaveBeenCalled();
    expect(req.hubPrincipal).toBeUndefined();
  });

  it('lets the device key and the CLI JWT answer first, without a key-store lookup', async () => {
    config.get.mockImplementation((key: string) => (key === 'ciHubApiKey' ? QA_KEY : key === 'jwtSecret' ? 'jwt-secret' : undefined));
    userRepository.getFirstOperator.mockResolvedValue({ id: 1, username: 'op@example.com' });

    const device = bearer(QA_KEY);
    await middleware.use(device, {} as never, vi.fn());
    const cli = bearer(jsonwebtoken.sign({ sub: 'cli' }, 'jwt-secret'));
    await middleware.use(cli, {} as never, vi.fn());

    expect(device.hubPrincipal).toBe('portal-device');
    expect(cli.hubPrincipal).toBe('cli');
    expect(repo.findByHash).not.toHaveBeenCalled();
  });

  it('leaves the request unauthenticated, not failed, when the key store cannot answer', async () => {
    repo.findByHash.mockRejectedValue(new Error('relation "api_key" does not exist'));
    const req = bearer(QA_KEY);
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(req.hubPrincipal).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});
