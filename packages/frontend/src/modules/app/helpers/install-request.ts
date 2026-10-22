import type { GetAppDto } from '@/api-client';
import { useIsMutating } from '@tanstack/react-query';

/** The key the install dialog's request runs under, so the page can tell that it is still out. */
export const installRequestKey = (appUrn: string) => ['install-request', appUrn] as const;

/** True from the moment an install request for `appUrn` leaves until the Hub answers it. */
export function useInstallRequestPending(appUrn: string): boolean {
  return useIsMutating({ mutationKey: installRequestKey(appUrn) }) > 0;
}

/**
 * The app's record as its page shows it while an install request for it is out.
 *
 * The Hub writes the app's row only after its checks (Companion Portal, the install bundle, the
 * image registry), and on a slow link that takes several seconds. A read of the app in that time,
 * such as the refetch a window focus starts, still finds no row (or the failed one being retried)
 * and put the page back on Install while the install went ahead.
 */
export function withInstallRequest(record: GetAppDto | undefined, appUrn: string, pending: boolean): GetAppDto | undefined {
  if (!pending || (record?.app && record.app.status !== 'install_failed')) {
    return record;
  }

  const [appName] = appUrn.split(':');
  const app = record?.app ? { ...record.app, status: 'installing' } : { id: appName, urn: appUrn, status: 'installing' };

  return { ...record, app } as unknown as GetAppDto;
}
