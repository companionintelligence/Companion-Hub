import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type KnownHub,
  loadKnownHubs,
  matchHubByName,
  parseIntentAction,
  publishHubsToIntents,
  resolveIntentNavigation,
  takePendingIntent,
} from './app-intents';

const mc = vi.hoisted(() => ({
  isMobile: true,
  baseUrl: null as string | null,
  setHub: vi.fn(async (..._a: unknown[]) => {}),
  clearHub: vi.fn(async () => {}),
}));
vi.mock('@/lib/mobile-connection', () => ({
  isTauriMobileSync: () => mc.isMobile,
  getHubBaseUrlSync: () => mc.baseUrl,
  setHubConnection: (...a: unknown[]) => mc.setHub(...(a as [string])),
  clearHubConnection: () => mc.clearHub(),
}));

const store = vi.hoisted(() => ({ data: {} as Record<string, unknown>, set: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-store', () => ({
  load: async () => ({
    get: async (k: string) => store.data[k],
    set: async (k: string, v: unknown) => {
      store.data[k] = v;
      store.set(k, v);
    },
    save: async () => store.save(),
  }),
}));

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => core.invoke(...a) }));

const HUBS: KnownHub[] = [
  { id: 'a', name: 'Apple Hub', hubUrl: 'https://hub-apple.ci.computer' },
  { id: 'b', name: 'Office Beta', hubUrl: 'https://hub-office.ci.computer' },
  { id: 'c', name: 'No Address', hubUrl: null },
];

beforeEach(() => {
  mc.isMobile = true;
  mc.baseUrl = null;
  mc.setHub.mockClear();
  mc.clearHub.mockClear();
  store.data = {};
  store.set.mockClear();
  store.save.mockClear();
  core.invoke.mockReset();
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

describe('parseIntentAction', () => {
  it('parses the bare actions', () => {
    expect(parseIntentAction('home')).toEqual({ kind: 'home' });
    expect(parseIntentAction('connect')).toEqual({ kind: 'connect' });
    expect(parseIntentAction('switch')).toEqual({ kind: 'switch' });
    expect(parseIntentAction('settings')).toEqual({ kind: 'settings' });
  });

  it('parses and URL-decodes the open-by-name action', () => {
    expect(parseIntentAction('open?hub=Apple%20Hub')).toEqual({ kind: 'open', hub: 'Apple Hub' });
    expect(parseIntentAction('open')).toEqual({ kind: 'open', hub: '' });
  });

  it('is case-insensitive on the action and rejects junk', () => {
    expect(parseIntentAction('SETTINGS')).toEqual({ kind: 'settings' });
    expect(parseIntentAction('bogus')).toBeNull();
    expect(parseIntentAction('')).toBeNull();
    expect(parseIntentAction(null)).toBeNull();
  });
});

describe('matchHubByName', () => {
  it('matches exactly, case-insensitively', () => {
    expect(matchHubByName(HUBS, 'apple hub')?.id).toBe('a');
  });
  it('matches a unique substring', () => {
    expect(matchHubByName(HUBS, 'office')?.id).toBe('b');
    expect(matchHubByName(HUBS, 'hub')?.id).toBe('a'); // only "Apple Hub" contains it
  });
  it('returns null on ambiguous or empty input', () => {
    expect(matchHubByName(HUBS, 'o')).toBeNull(); // "Office Beta" + "No Address" — ambiguous
    expect(matchHubByName(HUBS, '')).toBeNull();
    expect(matchHubByName(HUBS, 'nonexistent')).toBeNull();
  });
});

describe('resolveIntentNavigation', () => {
  it('maps home/settings without side effects', async () => {
    expect(await resolveIntentNavigation({ kind: 'home' }, HUBS)).toEqual({ path: '/', reload: false });
    expect(await resolveIntentNavigation({ kind: 'settings' }, HUBS)).toEqual({ path: '/settings', reload: false });
    expect(mc.setHub).not.toHaveBeenCalled();
    expect(mc.clearHub).not.toHaveBeenCalled();
  });

  it('connect/switch clear the active connection so the picker actually shows', async () => {
    expect(await resolveIntentNavigation({ kind: 'connect' }, HUBS)).toEqual({ path: '/connect', reload: true });
    expect(await resolveIntentNavigation({ kind: 'switch' }, HUBS)).toEqual({ path: '/connect', reload: true });
    expect(mc.clearHub).toHaveBeenCalledTimes(2);
  });

  it('opens a different reachable Hub: re-points the client and reloads', async () => {
    mc.baseUrl = 'https://hub-office.ci.computer';
    const nav = await resolveIntentNavigation({ kind: 'open', hub: 'Apple Hub' }, HUBS);
    expect(mc.setHub).toHaveBeenCalledWith('https://hub-apple.ci.computer');
    expect(nav).toEqual({ path: '/', reload: true });
  });

  it('opening the already-connected Hub does not re-point', async () => {
    mc.baseUrl = 'https://hub-apple.ci.computer';
    const nav = await resolveIntentNavigation({ kind: 'open', hub: 'Apple Hub' }, HUBS);
    expect(mc.setHub).not.toHaveBeenCalled();
    expect(nav).toEqual({ path: '/', reload: false });
  });

  it('falls back to the picker for an unknown or unreachable Hub name', async () => {
    expect(await resolveIntentNavigation({ kind: 'open', hub: 'Ghost' }, HUBS)).toEqual({ path: '/connect', reload: true });
    expect(await resolveIntentNavigation({ kind: 'open', hub: 'No Address' }, HUBS)).toEqual({ path: '/connect', reload: true });
    expect(mc.setHub).not.toHaveBeenCalled();
    expect(mc.clearHub).toHaveBeenCalledTimes(2);
  });
});

describe('publishHubsToIntents + loadKnownHubs', () => {
  it('persists hubs on mobile and reads them back', async () => {
    await publishHubsToIntents(HUBS);
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(await loadKnownHubs()).toEqual(HUBS);
  });

  it('is a no-op off mobile', async () => {
    mc.isMobile = false;
    await publishHubsToIntents(HUBS);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('loadKnownHubs returns [] when nothing is stored', async () => {
    expect(await loadKnownHubs()).toEqual([]);
  });
});

describe('takePendingIntent', () => {
  it('drains and parses a cold-start intent', async () => {
    core.invoke.mockResolvedValue('open?hub=Apple%20Hub');
    expect(await takePendingIntent()).toEqual({ kind: 'open', hub: 'Apple Hub' });
    expect(core.invoke).toHaveBeenCalledWith('consume_pending_intent');
  });

  it('returns null when nothing was pending', async () => {
    core.invoke.mockResolvedValue(null);
    expect(await takePendingIntent()).toBeNull();
  });

  it('returns null outside Tauri', async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    expect(await takePendingIntent()).toBeNull();
    expect(core.invoke).not.toHaveBeenCalled();
  });
});
