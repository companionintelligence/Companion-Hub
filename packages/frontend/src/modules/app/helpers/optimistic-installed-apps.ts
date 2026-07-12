import type { GetInstalledAppsResponse } from '@/api-client';
import { getInstalledAppsQueryKey } from '@/api-client/@tanstack/react-query.gen';
import type { QueryClient } from '@tanstack/react-query';

type InstalledEntry = GetInstalledAppsResponse['installed'][number];

/**
 * A synthetic `app.id` for a row that does not exist in the database yet.
 *
 * It must be (a) unique per app and (b) impossible to confuse with a real id. Real ids come from a
 * postgres `serial`, so they are always >= 1 — every id here is negative. Uniqueness matters because
 * the dashboard keys its tiles by identity: when several optimistic rows shared one id, React kept a
 * single fiber for them, left the surplus fibers undeleted, and stranded their DOM nodes on screen
 * (N apps rendered as 2N-1 tiles after onboarding). Deriving the id from the urn also makes it
 * idempotent, so a double-clicked retry re-uses the same row instead of minting a new one.
 */
function optimisticAppId(urn: string): number {
  let hash = 5381;
  for (let i = 0; i < urn.length; i++) {
    hash = ((hash << 5) + hash + urn.charCodeAt(i)) | 0;
  }

  return -(Math.abs(hash) % 2_000_000_000) - 1;
}

/** True for rows this module invented, i.e. never persisted. Real (serial) ids are always >= 1. */
export function isOptimisticAppId(id: number | undefined): boolean {
  return typeof id === 'number' && id < 0;
}

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
      id: optimisticAppId(params.urn),
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
  queryClient.setQueryData(installedKey, { ...existing, installed: [optimistic, ...filtered] });
}

/**
 * Drop the synthetic row for `urn` — call this when an install settles unsuccessfully, so the user
 * is not left staring at a spinner for an app that will never exist.
 *
 * Only ever removes rows we invented. The retry flow optimistically overwrites a REAL `install_failed`
 * row with the same urn, and removing that would make the tile vanish instead of returning it to its
 * failed state.
 */
export function removeOptimisticInstalledApp(queryClient: QueryClient, urn: string) {
  const installedKey = getInstalledAppsQueryKey();
  const existing = queryClient.getQueryData(installedKey) as GetInstalledAppsResponse | undefined;

  if (!existing?.installed) {
    return;
  }

  const remaining = existing.installed.filter((it) => !(it.info?.urn === urn && isOptimisticAppId(it.app?.id)));

  if (remaining.length === existing.installed.length) {
    return;
  }

  queryClient.setQueryData(installedKey, { ...existing, installed: remaining });
}
