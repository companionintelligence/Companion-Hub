import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { AuthMiddleware, sessionIdsFromRequest } from '../auth.middleware';
import type { Request } from 'express';
import jsonwebtoken from 'jsonwebtoken';

describe('AuthMiddleware transient DB handling', () => {
  const sessionManager = {
    resolveSessionUserId: vi.fn(),
    getSessionExpiresAt: vi.fn(),
    touchSession: vi.fn(),
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
