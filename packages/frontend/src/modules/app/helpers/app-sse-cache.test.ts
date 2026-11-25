import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { getAppQueryKey, getInstalledAppsQueryKey, appContextQueryKey, getUpdatesAvailableQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { handleAppSseEvent, appHubAccessQueryKey, invalidateAppRecords } from './app-sse-cache';

describe('invalidateAppRecords', () => {
  it('marks every app record and the installed list stale but leaves the rest alone', () => {
    const client = new QueryClient();
    const oneApp = getAppQueryKey({ path: { urn: 'one:store' } });
    const otherApp = getAppQueryKey({ path: { urn: 'other:store' } });
    const installed = getInstalledAppsQueryKey();
    const context = appContextQueryKey();
    for (const key of [oneApp, otherApp, installed, context]) {
      client.setQueryData(key, {});
    }

    invalidateAppRecords(client);

    expect(client.getQueryState(oneApp)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherApp)?.isInvalidated).toBe(true);
    expect(client.getQueryState(installed)?.isInvalidated).toBe(true);
    expect(client.getQueryState(context)?.isInvalidated).toBe(false);
  });

  // A rotate's restart can finish while the stream is down, and its restart_success never arrives (#2540).
  it('marks every Hub access panel stale', () => {
    const client = new QueryClient();
    const panels = [appHubAccessQueryKey('one:store'), appHubAccessQueryKey('other:store')];
    for (const key of panels) {
      client.setQueryData(key, {});
    }

    invalidateAppRecords(client);

    for (const key of panels) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });

  it('marks a listing that failed while the Hub was away stale and leaves a loaded one alone', async () => {
    const client = new QueryClient();
    const failed = ['app-listing', 'one:store'];
    const loaded = ['app-listing', 'other:store'];
    await client.fetchQuery({ queryKey: failed, queryFn: () => Promise.reject(new Error('Bad Gateway')), retry: false }).catch(() => undefined);
    client.setQueryData(loaded, {});

    invalidateAppRecords(client);

    expect(client.getQueryState(failed)?.isInvalidated).toBe(true);
    expect(client.getQueryState(loaded)?.isInvalidated).toBe(false);
  });
});

// CI-Hub#2376: an ignore in another tab or through the MCP tool left this page's update buttons and
// Home's "Update all" as they were.
describe('ignored_version_changed', () => {
  it('marks the app and the update count stale and leaves other apps alone', () => {
    const client = new QueryClient();
    const app = getAppQueryKey({ path: { urn: 'one:store' } });
    const otherApp = getAppQueryKey({ path: { urn: 'other:store' } });
    const updates = getUpdatesAvailableQueryKey();
    for (const key of [app, otherApp, updates]) {
      client.setQueryData(key, {});
    }

    handleAppSseEvent(client, { event: 'ignored_version_changed', appUrn: 'one:store' });

    expect(client.getQueryState(app)?.isInvalidated).toBe(true);
    expect(client.getQueryState(updates)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherApp)?.isInvalidated).toBe(false);
  });
});

// CI-Hub#2540: Rotate restarts the app, which is when it gets its new key. The open panel had read the
// status while the app was still restarting and kept "not provisioned" until Settings was reopened.
describe('Hub access panel', () => {
  it.each([
    ['restart_success', 'running'],
    ['start_success', 'running'],
    ['restart_error', 'stopped'],
  ])('marks the panel of the app stale on %s and leaves other apps alone', (event, appStatus) => {
    const client = new QueryClient();
    const panel = appHubAccessQueryKey('one:store');
    const otherPanel = appHubAccessQueryKey('other:store');
    for (const key of [panel, otherPanel]) {
      client.setQueryData(key, {});
    }

    handleAppSseEvent(client, { event, appUrn: 'one:store', appStatus });

    expect(client.getQueryState(panel)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherPanel)?.isInvalidated).toBe(false);
  });
});
