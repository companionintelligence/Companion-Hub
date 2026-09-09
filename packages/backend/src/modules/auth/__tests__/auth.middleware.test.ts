import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { AuthMiddleware, sessionIdsFromRequest } from '../auth.middleware';
import type { Request } from 'express';

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
