import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import type { RegistrationStatus } from '@/lib/registration-status';

export const useRegistrationStatus = () => {
  return useQuery<RegistrationStatus>({
    queryKey: ['registration', 'status'],
    queryFn: async () => {
      const res = await apiFetch('/api/registration/status');
      if (!res.ok) {
        throw new Error('Failed to fetch registration status');
      }
      return res.json();
    },
    refetchInterval: (query) => (query.state.data?.phase === 'locally_ready' ? 30_000 : 5_000),
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
};
