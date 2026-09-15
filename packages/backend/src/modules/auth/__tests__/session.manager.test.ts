import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { CacheService } from '@/core/cache/cache.service';
import { SESSION_ROTATION_GRACE_SECONDS, SESSION_TTL_SECONDS, SessionManager } from '../session.manager';

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

/**
 * App sessions against a cache that keeps TTLs: the lifetime cap and the cascade from the parent
 * only exist over time, so call assertions cannot see either.
 */
describe('SessionManager app sessions', () => {
  const APP = 'importer:ci-marketplace' as never;
  const HOUR_MS = 60 * 60 * 1000;

  function ttlCache() {
    const store = new Map<string, { value: string; expiresAt: number }>();
    const live = (key: string) => {
      const entry = store.get(key);
      if (entry && entry.expiresAt < Date.now()) {
        store.delete(key);
        return undefined;
      }
      return entry;
    };
    return {
      store,
      get: (key: string) => live(key)?.value,
      set: (key: string, value: string, ttlSeconds: number) => void store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 }),
      del: (key: string) => void store.delete(key),
      getExpirationAt: (key: string) => live(key)?.expiresAt ?? null,
      getByPrefix: (prefix: string) =>
        [...store.keys()].flatMap((key) => {
          const entry = key.startsWith(prefix) ? live(key) : undefined;
          return entry ? [{ key, val: entry.value }] : [];
        }),
    } as unknown as MockProxy<CacheService> & { store: Map<string, { value: string; expiresAt: number }> };
  }

  let cache: ReturnType<typeof ttlCache>;
  let manager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
    cache = ttlCache();
    manager = new SessionManager(cache);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves to its user, parent and app while the parent lives', async () => {
    const parent = await manager.createSession(7);

    const appSessionId = await manager.createAppSession(7, parent, APP);

    expect(appSessionId).toEqual(expect.any(String));
    expect(appSessionId).not.toBe(parent);
    expect(manager.resolveAppSession(appSessionId as string)).toEqual({ userId: 7, parentSessionId: parent, appUrn: APP });
  });

  it('is never a Hub session, and a Hub session is never an app session', async () => {
    // `AuthMiddleware` authenticates through `resolveSessionUserId` alone, so an app-session id that
    // resolved there would be the full Hub API credential this exists to keep off app hosts.
    const parent = await manager.createSession(7);
    const appSessionId = (await manager.createAppSession(7, parent, APP)) as string;

    expect(manager.resolveSessionUserId(appSessionId)).toBeNull();
    expect(manager.touchSession(appSessionId)).toBe(false);
    expect(manager.resolveAppSession(parent)).toBeNull();
    expect([...cache.store.keys()].filter((key) => key.includes(appSessionId))).toEqual([`app_session:${appSessionId}`]);
  });

  it('caps its lifetime at what the parent session has left', async () => {
    const parent = await manager.createSession(7);
    const early = (await manager.createAppSession(7, parent, APP)) as string;
    expect(cache.getExpirationAt(`app_session:${early}`)).toBe(Date.now() + SESSION_TTL_SECONDS * 1000);

    // Two hours before the parent expires, a new app session gets those two hours and no more.
    vi.advanceTimersByTime(SESSION_TTL_SECONDS * 1000 - 2 * HOUR_MS);
    const late = (await manager.createAppSession(7, parent, APP)) as string;
    expect(cache.getExpirationAt(`app_session:${late}`)).toBe(manager.getSessionExpiresAt(parent));

    // Under a second left rounds down to no lifetime at all, which is a refusal rather than a zero TTL.
    vi.advanceTimersByTime(2 * HOUR_MS - 500);
    await expect(manager.createAppSession(7, parent, APP)).resolves.toBeNull();
  });

  it('refuses to derive from a session that is gone or belongs to someone else', async () => {
    const parent = await manager.createSession(7);

    await expect(manager.createAppSession(9, parent, APP)).resolves.toBeNull();
    await expect(manager.createAppSession(7, 'no-such-session', APP)).resolves.toBeNull();
    expect([...cache.store.keys()].some((key) => key.startsWith('app_session:'))).toBe(false);
  });

  it('derives from a rotation-grace parent for no longer than the grace window', async () => {
    // A ticket minted just before its session rotated is consumed against the grace alias.
    const parent = await manager.createSession(7);
    await manager.rotateSession(parent);

    const appSessionId = await manager.createAppSession(7, parent, APP);

    expect(appSessionId).toEqual(expect.any(String));
    expect(cache.getExpirationAt(`app_session:${appSessionId}`)).toBeLessThanOrEqual(Date.now() + SESSION_ROTATION_GRACE_SECONDS * 1000);
  });

  it('stops resolving when the parent session is logged out', async () => {
    const parent = await manager.createSession(7);
    const appSessionId = (await manager.createAppSession(7, parent, APP)) as string;

    // What `AuthService.logout` does with the session it is handed.
    await manager.deleteSession(parent);

    expect(manager.resolveAppSession(appSessionId)).toBeNull();
    // Its parent never resolves again, so the refused record goes with it instead of lingering for its TTL.
    expect(cache.store.has(`app_session:${appSessionId}`)).toBe(false);
  });

  it('stops resolving once a rotated parent is past its grace window', async () => {
    const parent = await manager.createSession(7);
    const appSessionId = (await manager.createAppSession(7, parent, APP)) as string;

    await manager.rotateSession(parent);
    // In-flight requests keep the rotated id for the grace window, and what hangs off it with them.
    expect(manager.resolveAppSession(appSessionId)).not.toBeNull();

    vi.advanceTimersByTime((SESSION_ROTATION_GRACE_SECONDS + 1) * 1000);
    expect(manager.resolveAppSession(appSessionId)).toBeNull();
  });

  it('stops resolving after sign-out-everywhere', async () => {
    const parent = await manager.createSession(7);
    const appSessionId = (await manager.createAppSession(7, parent, APP)) as string;

    await manager.destroyAllSessionsByUserId(7);

    expect(manager.resolveAppSession(appSessionId)).toBeNull();
  });

  it('is extended as its parent is extended, and never past it', async () => {
    const DAY_MS = 24 * HOUR_MS;
    const parent = await manager.createSession(7);
    // Minted four days in, the app session gets the three days its parent has left.
    vi.advanceTimersByTime(4 * DAY_MS);
    const appSessionId = (await manager.createAppSession(7, parent, APP)) as string;
    const key = `app_session:${appSessionId}`;
    expect(cache.getExpirationAt(key)).toBe(manager.getSessionExpiresAt(parent));

    // Hub traffic extends the parent (what `AuthMiddleware` does past half its TTL), and the app session follows.
    manager.touchSession(parent);
    expect(manager.resolveAppSession(appSessionId)).not.toBeNull();
    expect(cache.getExpirationAt(key)).toBe(manager.getSessionExpiresAt(parent));

    // So it still resolves past the expiry it was minted with.
    vi.advanceTimersByTime(3 * DAY_MS + HOUR_MS);
    expect(manager.resolveAppSession(appSessionId)).not.toBeNull();
  });

  it('lets no `grace:` id stand in for a rotated session, let alone extend it', async () => {
    // Ids are spliced into `session:` keys verbatim, so `grace:<id>` names the rotated session's alias.
    const rotated = await manager.createSession(7);
    await manager.rotateSession(rotated);
    const alias = `grace:${rotated}`;

    expect(manager.resolveSessionUserId(alias)).toBeNull();
    expect(manager.getSessionExpiresAt(alias)).toBeNull();
    expect(manager.touchSession(alias)).toBe(false);
    await expect(manager.rotateSession(alias)).resolves.toBeNull();
    await expect(manager.createAppSession(7, alias, APP)).resolves.toBeNull();

    // The alias keeps only its grace window, so the rotated id stops resolving when that ends.
    vi.advanceTimersByTime((SESSION_ROTATION_GRACE_SECONDS + 1) * 1000);
    expect(manager.resolveSessionUserId(rotated)).toBeNull();
  });

  it.each([
    ['an unreadable record', () => '{not json'],
    ['a JSON null', () => 'null'],
    ['a record that names no app', (parent: string) => JSON.stringify({ userId: 7, parentSessionId: parent })],
    ["a record whose user is not the parent session's", (parent: string) => JSON.stringify({ userId: 9, parentSessionId: parent, appUrn: APP })],
  ])('refuses %s', async (_label, record) => {
    const parent = await manager.createSession(7);
    cache.set('app_session:tampered', record(parent), 60);

    expect(manager.resolveAppSession('tampered')).toBeNull();
    expect(cache.store.has('app_session:tampered')).toBe(false);
  });
});
