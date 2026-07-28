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

  it('extends session TTL on touch', () => {
    cache.get.mockReturnValue('9');

    expect(manager.touchSession('session-1')).toBe(true);
    expect(cache.set).toHaveBeenCalledWith('session:session-1', '9', 60 * 60 * 24 * 7);
    expect(cache.set).toHaveBeenCalledWith('session:9:session-1', 'session:session-1', 60 * 60 * 24 * 7);
  });

  it('returns session expiry from cache metadata', () => {
    cache.getExpirationAt.mockReturnValue(1_700_000_000_000);

    expect(manager.getSessionExpiresAt('session-1')).toBe(1_700_000_000_000);
    expect(cache.getExpirationAt).toHaveBeenCalledWith('session:session-1');
  });

  it('resolves grace sessions during rotation overlap', () => {
    cache.get.mockImplementation((key: string) => {
      if (key === 'session:old-session') return undefined;
      if (key === 'session:grace:old-session') return '3';
      return undefined;
    });

    expect(manager.resolveSessionUserId('old-session')).toBe(3);
  });

  it('stores a grace mapping when rotating sessions', async () => {
    cache.get.mockReturnValue('7');
    cache.del.mockImplementation(() => undefined);

    await manager.rotateSession('old-session');

    expect(cache.set).toHaveBeenCalledWith('session:grace:old-session', '7', 60);
  });

  it('destroys every session for a user', async () => {
    cache.getByPrefix.mockImplementation((prefix: string) =>
      prefix === 'session:7:'
        ? [
            { key: 'session:7:aaa', val: 'session:aaa' },
            { key: 'session:7:bbb', val: 'session:bbb' },
          ]
        : [],
    );

    await manager.destroyAllSessionsByUserId(7);

    expect(cache.getByPrefix).toHaveBeenCalledWith('session:7:');
    expect(cache.del).toHaveBeenCalledWith('session:7:aaa');
    expect(cache.del).toHaveBeenCalledWith('session:aaa');
  });
});

/**
 * Driven against a behavioural cache rather than call assertions: the grace-alias gap
 * only exists because `rotateSession` unlinks the session from the per-user index, so a
 * test that hands `destroyAllSessionsByUserId` a hand-written index cannot see it.
 */
describe('SessionManager sign-out-everywhere against a real key space', () => {
  function fakeCache() {
    const store = new Map<string, string>();
    return {
      store,
      get: (key: string) => store.get(key),
      set: (key: string, value: string) => void store.set(key, value),
      del: (key: string) => void store.delete(key),
      getByPrefix: (prefix: string) => [...store.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, val]) => ({ key, val })),
    } as unknown as MockProxy<CacheService> & { store: Map<string, string> };
  }

  it('revokes a session that was rotated within the grace window', async () => {
    const cache = fakeCache();
    const manager = new SessionManager(cache);
    const original = await manager.createSession(7);
    await manager.rotateSession(original);

    // The rotated id still authenticates during the 60s overlap — that is the whole
    // point of the grace alias, and why a sign-out has to reach it.
    expect(manager.resolveSessionUserId(original)).toBe(7);

    await manager.destroyAllSessionsByUserId(7);

    expect(manager.resolveSessionUserId(original)).toBeNull();
    expect([...cache.store.keys()]).toEqual([]);
  });

  it('leaves a grace alias belonging to a different user alone', async () => {
    const cache = fakeCache();
    const manager = new SessionManager(cache);
    const theirs = await manager.createSession(9);
    await manager.rotateSession(theirs);

    await manager.destroyAllSessionsByUserId(7);

    expect(manager.resolveSessionUserId(theirs)).toBe(9);
  });
});
