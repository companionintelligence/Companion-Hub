import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { AuthMiddleware } from '../auth.middleware';

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

  let middleware: AuthMiddleware;

  beforeEach(() => {
    vi.clearAllMocks();
    middleware = new AuthMiddleware(sessionManager as never, config as never, userRepository as never);
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
});
