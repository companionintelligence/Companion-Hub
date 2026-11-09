import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { getAppQueryKey, getInstalledAppsQueryKey, appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { invalidateAppRecords } from './app-sse-cache';

describe('invalidateAppRecords', () => {
  it('marks every app record and the installed list stale, and leaves the rest alone', () => {
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
});
