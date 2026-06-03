import type { GetInstalledAppsResponse } from '@/api-client';
import { getInstalledAppsQueryKey } from '@/api-client/@tanstack/react-query.gen';
import type { QueryClient } from '@tanstack/react-query';

type InstalledEntry = GetInstalledAppsResponse['installed'][number];

export function addOptimisticInstalledApp(queryClient: QueryClient, params: { urn: string; name: string; slug: string; localSubdomain?: string }) {
  const installedKey = getInstalledAppsQueryKey();
  const existing = queryClient.getQueryData(installedKey) as GetInstalledAppsResponse | undefined;
  const installedList = existing?.installed ?? [];
  const filtered = installedList.filter((it) => it.info?.urn !== params.urn);
  const optimistic: InstalledEntry = {
    info: {
      urn: params.urn,
      id: params.slug,
      name: params.name,
      available: true,
    } as InstalledEntry['info'],
    app: {
      id: -1,
      status: 'installing',
      domain: null,
      exposed: false,
      exposedLocal: false,
      ignoredVersion: null,
      isVisibleOnGuestDashboard: false,
      openPort: false,
      pendingRestart: false,
      port: null,
      version: 0,
    },
    metadata: { latestVersion: 0, localSubdomain: params.localSubdomain ?? '' } as InstalledEntry['metadata'],
  };
  queryClient.setQueryData(installedKey, { installed: [optimistic, ...filtered] });
}

export function removeOptimisticInstalledApp(queryClient: QueryClient, urn: string) {
  const installedKey = getInstalledAppsQueryKey();
  const existing = queryClient.getQueryData(installedKey) as GetInstalledAppsResponse | undefined;
  const installedList = existing?.installed ?? [];
  const filtered = installedList.filter((it) => it.info?.urn !== urn);
  queryClient.setQueryData(installedKey, { installed: filtered });
}
