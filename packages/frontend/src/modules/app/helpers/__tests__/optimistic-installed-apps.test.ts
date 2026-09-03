import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addOptimisticInstalledApp, isOptimisticAppId, removeOptimisticInstalledApp } from '../optimistic-installed-apps';

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getInstalledAppsQueryKey: () => ['getInstalledApps'],
  getInstalledAppUrnsQueryKey: () => ['getInstalledAppUrns'],
}));

const KEY = ['getInstalledApps'];

const HERMES = { urn: 'ci-hermes:ci-marketplace', name: 'Hermes', slug: 'ci-hermes' };
const PLANNING = { urn: 'ci-planning:ci-marketplace', name: 'Companion Planning', slug: 'ci-planning' };

describe('optimistic installed apps', () => {
  let queryClient: QueryClient;

  const installed = () => (queryClient.getQueryData(KEY) as { installed: any[] } | undefined)?.installed ?? [];

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('seeds an installing row for a freshly enqueued app', () => {
    addOptimisticInstalledApp(queryClient, HERMES);

    expect(installed()).toHaveLength(1);
    expect(installed()[0].info.urn).toBe(HERMES.urn);
    expect(installed()[0].info.name).toBe('Hermes');
    expect(installed()[0].app.status).toBe('installing');
  });

  // The ghost-tile bug: onboarding enqueues every selected app at once, and each optimistic row used
  // to hardcode `app.id: -1`. The dashboard keys tiles by `app.id`, so they collided on one React key
  // and stranded DOM nodes. Distinct ids are what make the keys safe.
  it('MUST give concurrently enqueued apps distinct app ids', () => {
    addOptimisticInstalledApp(queryClient, HERMES);
    addOptimisticInstalledApp(queryClient, PLANNING);

    const ids = installed().map((entry) => entry.app.id);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('MUST keep optimistic ids negative so they can never collide with a real serial id', () => {
    addOptimisticInstalledApp(queryClient, HERMES);
    addOptimisticInstalledApp(queryClient, PLANNING);

    for (const entry of installed()) {
      expect(entry.app.id).toBeLessThan(0);
      expect(isOptimisticAppId(entry.app.id)).toBe(true);
    }
    expect(isOptimisticAppId(1)).toBe(false);
  });

  it('is idempotent for the same app — one row, same id (a double-clicked retry must not mint a new id)', () => {
    addOptimisticInstalledApp(queryClient, HERMES);
    const firstId = installed()[0].app.id;

    addOptimisticInstalledApp(queryClient, HERMES);

    expect(installed()).toHaveLength(1);
    expect(installed()[0].app.id).toBe(firstId);
  });

  it('preserves the real rows already in the cache', () => {
    queryClient.setQueryData(KEY, {
      installed: [{ info: { urn: 'ci-openclaw:ci-marketplace', name: 'OpenClaw' }, app: { id: 3, status: 'running' } }],
    });

    addOptimisticInstalledApp(queryClient, HERMES);

    expect(installed()).toHaveLength(2);
    expect(installed().map((e) => e.info.urn)).toContain('ci-openclaw:ci-marketplace');
  });

  describe('removeOptimisticInstalledApp', () => {
    it('drops the synthetic row when an install fails', () => {
      addOptimisticInstalledApp(queryClient, HERMES);

      removeOptimisticInstalledApp(queryClient, HERMES.urn);

      expect(installed()).toHaveLength(0);
    });

    // The retry button optimistically overwrites a REAL install_failed row. Removing that row would
    // make the tile disappear entirely, so only ever drop rows we invented.
    it('MUST leave a real row with the same urn intact', () => {
      queryClient.setQueryData(KEY, {
        installed: [{ info: { urn: HERMES.urn, name: 'Hermes' }, app: { id: 7, status: 'install_failed' } }],
      });

      removeOptimisticInstalledApp(queryClient, HERMES.urn);

      expect(installed()).toHaveLength(1);
      expect(installed()[0].app.id).toBe(7);
    });

    it('is a no-op on an empty cache or an unknown urn', () => {
      expect(() => removeOptimisticInstalledApp(queryClient, HERMES.urn)).not.toThrow();

      addOptimisticInstalledApp(queryClient, HERMES);
      removeOptimisticInstalledApp(queryClient, PLANNING.urn);

      expect(installed()).toHaveLength(1);
    });
  });
});
