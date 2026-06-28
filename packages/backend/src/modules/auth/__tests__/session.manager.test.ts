import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { CacheService } from '@/core/cache/cache.service';
import { SessionManager } from '../session.manager';

describe('SessionManager', () => {
  let cache: MockProxy<CacheService>;
  let manager: SessionManager;

  beforeEach(() => {
    cache = mock<CacheService>();
    manager = new SessionManager(cache);
  });

  it('creates sessions with a 7-day TTL', async () => {
    const sessionId = await manager.createSession(42);

    expect(sessionId).toEqual(expect.any(String));
    expect(cache.set).toHaveBeenCalledWith(`session:${sessionId}`, '42', 60 * 60 * 24 * 7);
    expect(cache.set).toHaveBeenCalledWith(`session:42:${sessionId}`, `session:${sessionId}`, 60 * 60 * 24 * 7);
  });

  it('rotates a valid session to a new id for the same user', async () => {
    cache.get.mockReturnValue('7');
    cache.del.mockImplementation(() => undefined);

    const nextSessionId = await manager.rotateSession('old-session');

    expect(nextSessionId).toEqual(expect.any(String));
    expect(nextSessionId).not.toBe('old-session');
    expect(cache.del).toHaveBeenCalledWith('session:old-session');
    expect(cache.del).toHaveBeenCalledWith('session:7:old-session');
    expect(cache.set).toHaveBeenCalledWith(`session:${nextSessionId}`, '7', 60 * 60 * 24 * 7);
  });

  it('returns null when rotating an expired or unknown session', async () => {
    cache.get.mockReturnValue(undefined);

    await expect(manager.rotateSession('missing-session')).resolves.toBeNull();
  });
});
