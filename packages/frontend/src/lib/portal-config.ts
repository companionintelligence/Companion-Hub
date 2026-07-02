import { getPortalConfigOptions } from '@/api-client/@tanstack/react-query.gen';

export type PortalConfig = {
  portalUrl: string | null;
  deviceId: string | null;
  registrationUrl: string | null;
  demoMode: boolean;
};

export function portalConfigQueryOptions() {
  const base = getPortalConfigOptions();
  return {
    ...base,
    select: (data: unknown) => data as PortalConfig,
    staleTime: 5 * 60 * 1000,
  } as const;
}

export function usePortalConfigQuery() {
  return portalConfigQueryOptions();
}
