import { useQuery } from '@tanstack/react-query';
import { getStatusOptions } from '@/api-client/@tanstack/react-query.gen';
import { POLLING } from '@/lib/polling-budget';
import type { RegistrationStatus } from '@/lib/registration-status';

export const useRegistrationStatus = () => {
  return useQuery({
    ...getStatusOptions(),
    select: (data) => data as RegistrationStatus,
    refetchInterval: (query) => {
      const status = query.state.data as RegistrationStatus | undefined;
      return status?.phase === 'locally_ready' ? 30_000 : POLLING.REGISTRATION_MS;
    },
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
};
